import * as fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { devtoApiKey, devtoFetch } from './auth.js';

// DEV.to 文章发布 / 更新。POST /api/articles（新建）或 PUT /api/articles/{id}（更新）。
// 参考 sinedied/devto-cli。原子能力：md 正文、草稿↔发布(published)、封面图(main_image)、
// tags(≤4)、canonical_url、series、description、organization。

const MAX_TAGS = 4;

function resolveBody(kwargs) {
  if (kwargs['body-file']) {
    const file = String(kwargs['body-file']);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new ArgumentError(`--body-file not found: ${file}`);
    }
    return fs.readFileSync(file, 'utf8');
  }
  if (kwargs.body !== undefined && kwargs.body !== null) return String(kwargs.body);
  return undefined;
}

// DEV.to 标签：小写、仅字母数字、最多 4 个。
function resolveTags(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const tags = String(raw).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length > MAX_TAGS) throw new ArgumentError(`Too many tags: ${tags.length} (DEV.to max ${MAX_TAGS})`);
  for (const t of tags) {
    if (!/^[a-z0-9]+$/.test(t)) {
      throw new ArgumentError(`Invalid tag "${t}". DEV.to tags must be lowercase alphanumeric (no spaces/punctuation).`);
    }
  }
  return tags;
}

cli({
  site: 'devto',
  name: 'publish',
  access: 'write',
  description: 'Publish or update a DEV.to article (markdown). Draft by default; pass --published to go live.',
  domain: 'dev.to',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'title', type: 'string', required: false, help: 'Article title (required for new articles)' },
    { name: 'body', type: 'string', required: false, help: 'Article body in Markdown (or use --body-file)' },
    { name: 'body-file', type: 'string', required: false, help: 'Path to a Markdown file for the body' },
    { name: 'published', type: 'boolean', required: false, default: false, help: 'Publish live now (default: save as draft)' },
    { name: 'tags', type: 'string', required: false, help: 'Comma-separated tags, max 4, lowercase alphanumeric' },
    { name: 'cover-image', type: 'string', required: false, help: 'Cover image URL (main_image)' },
    { name: 'canonical-url', type: 'string', required: false, help: 'Canonical URL (original source)' },
    { name: 'series', type: 'string', required: false, help: 'Series name to group articles' },
    { name: 'description', type: 'string', required: false, help: 'Social/SEO description' },
    { name: 'organization-id', type: 'int', required: false, help: 'Publish under an organization id' },
    { name: 'id', type: 'string', required: false, help: 'Existing article id to update (PUT instead of POST)' },
  ],
  columns: ['status', 'id', 'url', 'published', 'slug'],
  func: async (kwargs) => {
    const apiKey = devtoApiKey();
    const id = kwargs.id ? String(kwargs.id).trim() : '';
    const body = resolveBody(kwargs);
    const tags = resolveTags(kwargs.tags);

    if (!id && !kwargs.title) throw new ArgumentError('--title is required when creating a new article');
    if (!id && body === undefined) throw new ArgumentError('--body or --body-file is required when creating a new article');

    const article = {};
    if (kwargs.title !== undefined) article.title = String(kwargs.title);
    if (body !== undefined) article.body_markdown = body;
    if (kwargs.published !== undefined) article.published = !!kwargs.published;
    if (tags !== undefined) article.tags = tags;
    if (kwargs['cover-image']) article.main_image = String(kwargs['cover-image']);
    if (kwargs['canonical-url']) article.canonical_url = String(kwargs['canonical-url']);
    if (kwargs.series) article.series = String(kwargs.series);
    if (kwargs.description) article.description = String(kwargs.description);
    if (kwargs['organization-id'] !== undefined && kwargs['organization-id'] !== null) {
      article.organization_id = Number(kwargs['organization-id']);
    }

    const out = id
      ? await devtoFetch(apiKey, `/articles/${id}`, { method: 'PUT', body: JSON.stringify({ article }) })
      : await devtoFetch(apiKey, '/articles', { method: 'POST', body: JSON.stringify({ article }) });

    return [{
      status: id ? 'updated' : 'created',
      id: out.id,
      url: out.url ?? '',
      published: out.published ?? false,
      slug: out.slug ?? '',
    }];
  },
});
