import * as fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { hashnodeGql, hashnodeToken, resolvePublicationId } from './auth.js';

// Hashnode 文章发布。GraphQL publishPost（发布）/ createDraft（草稿）。
// 原子能力：md 正文、publicationId 解析、封面图、tags、canonical、subtitle、series、slug、draft。

function resolveBody(kwargs) {
  if (kwargs['body-file']) {
    const file = String(kwargs['body-file']);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new ArgumentError(`--body-file not found: ${file}`);
    return fs.readFileSync(file, 'utf8');
  }
  if (kwargs.body !== undefined && kwargs.body !== null) return String(kwargs.body);
  return undefined;
}

// Hashnode 标签是 {slug, name} 对象。由展示名派生 slug。
function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function resolveTags(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  return String(raw).split(',').map((t) => t.trim()).filter(Boolean).map((name) => ({ slug: slugify(name), name }));
}

const PUBLISH_MUTATION = `mutation Publish($input: PublishPostInput!) {
  publishPost(input: $input) { post { id slug url } }
}`;
const DRAFT_MUTATION = `mutation Draft($input: CreateDraftInput!) {
  createDraft(input: $input) { draft { id slug } }
}`;

cli({
  site: 'hashnode',
  name: 'publish',
  access: 'write',
  description: 'Publish a Hashnode post (or save a draft with --draft). Markdown body + cover/tags/canonical.',
  domain: 'hashnode.com',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'title', type: 'string', required: true, help: 'Post title' },
    { name: 'body', type: 'string', required: false, help: 'Post body in Markdown (or use --body-file)' },
    { name: 'body-file', type: 'string', required: false, help: 'Path to a Markdown file for the body' },
    { name: 'publication-id', type: 'string', required: false, help: 'Target publication id (else resolved automatically)' },
    { name: 'publication-host', type: 'string', required: false, help: 'Resolve publication id by host (e.g. blog.example.com)' },
    { name: 'tags', type: 'string', required: false, help: 'Comma-separated tag names (slug auto-derived)' },
    { name: 'cover-image', type: 'string', required: false, help: 'Cover image URL' },
    { name: 'canonical-url', type: 'string', required: false, help: 'Canonical / original article URL' },
    { name: 'subtitle', type: 'string', required: false, help: 'Subtitle' },
    { name: 'series-id', type: 'string', required: false, help: 'Series id to add the post to' },
    { name: 'slug', type: 'string', required: false, help: 'Custom slug' },
    { name: 'draft', type: 'boolean', required: false, default: false, help: 'Save as draft instead of publishing' },
  ],
  columns: ['status', 'id', 'slug', 'url'],
  func: async (kwargs) => {
    const token = hashnodeToken();
    const body = resolveBody(kwargs);
    if (body === undefined) throw new ArgumentError('--body or --body-file is required');

    const publicationId = await resolvePublicationId(token, {
      id: kwargs['publication-id'],
      host: kwargs['publication-host'],
    });

    const input = {
      title: String(kwargs.title),
      contentMarkdown: body,
      publicationId,
    };
    const tags = resolveTags(kwargs.tags);
    if (tags.length) input.tags = tags;
    if (kwargs['cover-image']) input.coverImageOptions = { coverImageURL: String(kwargs['cover-image']) };
    if (kwargs['canonical-url']) input.originalArticleURL = String(kwargs['canonical-url']);
    if (kwargs.subtitle) input.subtitle = String(kwargs.subtitle);
    if (kwargs['series-id']) input.seriesId = String(kwargs['series-id']);
    if (kwargs.slug) input.slug = String(kwargs.slug);

    if (kwargs.draft) {
      const data = await hashnodeGql(token, DRAFT_MUTATION, { input });
      const draft = data?.createDraft?.draft;
      return [{ status: 'draft', id: draft?.id ?? '', slug: draft?.slug ?? '', url: '' }];
    }

    const data = await hashnodeGql(token, PUBLISH_MUTATION, { input });
    const post = data?.publishPost?.post;
    return [{ status: 'published', id: post?.id ?? '', slug: post?.slug ?? '', url: post?.url ?? '' }];
  },
});
