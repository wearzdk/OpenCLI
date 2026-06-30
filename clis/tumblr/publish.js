import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { blogHost, tumblrCreds, tumblrFetch } from './auth.js';

// Tumblr 发帖（NPF）。POST /v2/blog/{blog}/posts。原子能力：text/photo(URL)/link 内容块、
// tags、state(published/draft/queue/private)、多博客选择(--blog / 凭证 default_blog)。

const STATES = ['published', 'draft', 'queue', 'private'];

function buildContent(kwargs) {
  const content = [];
  if (kwargs.title) content.push({ type: 'text', subtype: 'heading1', text: String(kwargs.title) });
  if (kwargs['image-url']) content.push({ type: 'image', media: [{ url: String(kwargs['image-url']) }] });
  if (kwargs.text) content.push({ type: 'text', text: String(kwargs.text) });
  if (kwargs.link) content.push({ type: 'link', url: String(kwargs.link) });
  if (content.length === 0) {
    throw new ArgumentError('Provide at least one of --text, --title, --image-url, or --link');
  }
  return content;
}

cli({
  site: 'tumblr',
  name: 'post',
  access: 'write',
  description: 'Create a Tumblr post (NPF: text/photo/link). Choose blog with --blog; state defaults to published.',
  domain: 'tumblr.com',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'text', type: 'string', required: false, help: 'Body text block' },
    { name: 'title', type: 'string', required: false, help: 'Heading text block (rendered as a title)' },
    { name: 'image-url', type: 'string', required: false, help: 'Image URL (photo block)' },
    { name: 'link', type: 'string', required: false, help: 'Link URL (link block)' },
    { name: 'tags', type: 'string', required: false, help: 'Comma-separated tags' },
    { name: 'state', type: 'string', required: false, default: 'published', choices: STATES, help: 'published | draft | queue | private' },
    { name: 'blog', type: 'string', required: false, help: 'Blog identifier to post to (else credential default_blog / primary)' },
  ],
  columns: ['status', 'id', 'blog', 'state', 'url'],
  func: async (kwargs) => {
    const creds = tumblrCreds();
    const state = String(kwargs.state ?? 'published');
    if (!STATES.includes(state)) throw new ArgumentError(`Invalid --state "${state}". One of: ${STATES.join(', ')}`);

    const blogName = kwargs.blog ? String(kwargs.blog) : creds.default_blog;
    if (!blogName) {
      throw new ArgumentError('No target blog. Pass --blog or set default_blog at login (`opencli tumblr login --default-blog <name>`).');
    }
    const host = blogHost(blogName);

    const content = buildContent(kwargs);
    const tags = kwargs.tags ? String(kwargs.tags).split(',').map((t) => t.trim()).filter(Boolean).join(',') : '';

    const payload = { content, state };
    if (tags) payload.tags = tags;

    const res = await tumblrFetch(creds, 'POST', `/blog/${host}/posts`, payload);
    const id = res.id_string ?? (res.id != null ? String(res.id) : '');
    if (!id) throw new CommandExecutionError('Tumblr post response missing id');

    return [{
      status: 'success',
      id,
      blog: host,
      state,
      url: `https://${host}/post/${id}`,
    }];
  },
});
