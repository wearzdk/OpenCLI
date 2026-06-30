/**
 * Tumblr 发帖（NPF）—— [pp-only] 复用浏览器登录态，照搬 auth.js 同款 window.tumblr.apiFetch：
 * 在已登录的 tumblr.com 仪表盘（同源）页面内调用 apiFetch，它内部自动带好 Authorization: Bearer
 * 与 X-CSRF（运行时现取、自动续期），不再要求用户去 tumblr.com/oauth/apps 注册 app 拿 OAuth1 四件套。
 *
 * 端点与字段全部照抄 Tumblr 官方开源文档 tumblr/docs（Apache-2.0）：
 *   - 建帖：POST /v2/blog/{blog-identifier}/posts，body 含 content(NPF 数组)、state、tags(逗号分隔)。
 *     https://github.com/tumblr/docs/blob/master/api.md（「Create/Reblog a Post (Neue Post Format)」）
 *   - 删帖：POST /v2/blog/{blog-identifier}/post/delete，body 含 id。
 *     https://github.com/tumblr/docs/blob/master/api.md（「Delete a Post」，legacy 端点用 POST 非 DELETE）
 * apiFetch 的 body 传普通对象（它自动 stringify）、返回已解析 JSON `{ response: {...} }`：
 *   https://github.com/tumblr/docs/blob/master/web-platform.md（「apiFetch accepts an object as the body param, and stringifies it for you」）
 *   apiFetch 用法另见 XKit-Rewritten（GPL-3.0）src/main_world/api_fetch.js。
 *
 * 真机 verify：`opencli tumblr login` → `opencli tumblr whoami` → `opencli tumblr publish --title ... --text ... --state draft`
 *   （先草稿，回查无误后 --state published 真发，再用同款 apiFetch DELETE 删除测试内容）。
 */
import * as fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const HOME = 'https://www.tumblr.com';
const DASHBOARD = 'https://www.tumblr.com/dashboard';

const STATES = ['published', 'draft', 'queue', 'private'];

// blog 标识符规范化：裸名 `myblog` → `myblog.tumblr.com`（已含 . 的自定义域 / 完整主机名原样保留）。
export function blogHost(blog) {
  const b = String(blog || '').trim();
  if (!b) return '';
  return b.includes('.') ? b : `${b}.tumblr.com`;
}

// 取正文：--body-file 优先，其次 --body / --text。纯函数，便于测试。
export function resolveBody(kwargs) {
  if (kwargs['body-file']) {
    const file = String(kwargs['body-file']);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new ArgumentError(`--body-file not found: ${file}`);
    }
    return fs.readFileSync(file, 'utf8');
  }
  if (kwargs.body !== undefined && kwargs.body !== null) return String(kwargs.body);
  if (kwargs.text !== undefined && kwargs.text !== null) return String(kwargs.text);
  return undefined;
}

// 组装 NPF content 数组：标题→heading1 文本块；正文按空行拆段，每段一个 text 块；
// 可选图片 URL→image 块；可选链接 URL→link 块。纯函数，便于测试。
export function buildContent(kwargs, body) {
  const content = [];
  if (kwargs.title) content.push({ type: 'text', subtype: 'heading1', text: String(kwargs.title) });
  if (body !== undefined && body !== '') {
    for (const para of String(body).split(/\n{2,}/)) {
      const t = para.replace(/\n+$/, '');
      if (t.trim() !== '') content.push({ type: 'text', text: t });
    }
  }
  if (kwargs['image-url']) content.push({ type: 'image', media: [{ url: String(kwargs['image-url']) }] });
  if (kwargs.link) content.push({ type: 'link', url: String(kwargs.link) });
  if (content.length === 0) {
    throw new ArgumentError('Provide at least one of --title, --text/--body/--body-file, --image-url, or --link');
  }
  return content;
}

// tags：逗号分隔 → 去空白去空项 → 逗号拼回（Tumblr 官方 tags 形态即 comma-separated string）。
export function resolveTags(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  return String(raw).split(',').map((t) => t.trim()).filter(Boolean).join(',');
}

// 在已登录的 tumblr.com 页面内用 window.tumblr.apiFetch 发请求；apiFetch 自带 Bearer+CSRF，
// body 传普通对象（apiFetch 自动 stringify），返回 { kind, ... }。失败映射成 typed error 由调用方抛。
async function apiFetch(page, resource, init) {
  return page.evaluate(`(async () => {
    try {
      if (!(window.tumblr && typeof window.tumblr.apiFetch === 'function')) {
        return { kind: 'auth', detail: 'apiFetch unavailable — not on a logged-in tumblr page?' };
      }
      var r = await window.tumblr.apiFetch(${JSON.stringify(resource)}, ${JSON.stringify(init)});
      return { kind: 'ok', response: (r && r.response) || null, meta: (r && r.meta) || null };
    } catch (e) {
      var status = (e && (e.status || (e.body && e.body.meta && e.body.meta.status))) || 0;
      var msg = (e && (e.message || (e.body && e.body.meta && e.body.meta.msg))) || String(e);
      if (status === 401 || status === 403) return { kind: 'auth', detail: 'HTTP ' + status + ' ' + msg };
      return { kind: 'http', status: status, detail: String(msg).slice(0, 300) };
    }
  })()`);
}

// 取目标博客：--blog 优先；否则用 apiFetch /v2/user/info 的主博客（primary）。
async function resolveBlog(page, kwargs) {
  if (kwargs.blog) return blogHost(kwargs.blog);
  const info = await apiFetch(page, '/v2/user/info', { method: 'GET' });
  if (info?.kind === 'auth') {
    throw new AuthRequiredError('tumblr.com', `Not logged in (${info.detail}). Run \`opencli tumblr login\`.`);
  }
  if (info?.kind !== 'ok' || !info.response || !info.response.user) {
    throw new CommandExecutionError(`Failed to resolve default blog: ${JSON.stringify(info)}`);
  }
  const blogs = info.response.user.blogs || [];
  const primary = blogs.find((b) => b.primary) || blogs[0];
  if (!primary || !primary.name) {
    throw new CommandExecutionError('No blog found on this account; pass --blog explicitly.');
  }
  return blogHost(primary.name);
}

cli({
  site: 'tumblr',
  name: 'publish',
  access: 'write',
  description: 'Publish a Tumblr post (NPF: title/text/image/link). Draft by default; pass --state published to go live.',
  domain: 'tumblr.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'title', type: 'string', required: false, help: 'Title (rendered as a heading1 text block)' },
    { name: 'text', type: 'string', required: false, help: 'Body text (blank lines split paragraphs); alias of --body' },
    { name: 'body', type: 'string', required: false, help: 'Body text (blank lines split paragraphs)' },
    { name: 'body-file', type: 'string', required: false, help: 'Path to a text file for the body' },
    { name: 'image-url', type: 'string', required: false, help: 'Image URL (NPF image block)' },
    { name: 'link', type: 'string', required: false, help: 'Link URL (NPF link block)' },
    { name: 'tags', type: 'string', required: false, help: 'Comma-separated tags' },
    { name: 'state', type: 'string', required: false, default: 'draft', choices: STATES, help: 'draft | published | queue | private (default: draft)' },
    { name: 'blog', type: 'string', required: false, help: 'Target blog identifier (else your primary blog)' },
  ],
  columns: ['status', 'id', 'blog', 'state', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for tumblr publish');
    const state = String(kwargs.state ?? 'draft');
    if (!STATES.includes(state)) {
      throw new ArgumentError(`Invalid --state "${state}". One of: ${STATES.join(', ')}`);
    }

    const body = resolveBody(kwargs);
    const content = buildContent(kwargs, body);
    const tags = resolveTags(kwargs.tags);

    // 打开已登录的 tumblr 仪表盘（同源，window.tumblr.apiFetch 可用）。
    await page.goto(DASHBOARD);

    const host = await resolveBlog(page, kwargs);

    const npfBody = { content, state };
    if (tags) npfBody.tags = tags;

    const res = await apiFetch(page, `/v2/blog/${host}/posts`, { method: 'POST', body: npfBody });
    if (res?.kind === 'auth') {
      throw new AuthRequiredError('tumblr.com', `Not logged in (${res.detail}). Run \`opencli tumblr login\`.`);
    }
    if (res?.kind === 'http') {
      throw new CommandExecutionError(`Tumblr publish failed: HTTP ${res.status} ${res.detail}`);
    }
    if (res?.kind !== 'ok' || !res.response) {
      throw new CommandExecutionError(`Unexpected Tumblr response: ${JSON.stringify(res)}`);
    }
    const id = res.response.id_string ?? (res.response.id != null ? String(res.response.id) : '');
    if (!id) throw new CommandExecutionError('Tumblr post response missing id');

    // 草稿无公开 URL，不回报半成品链接；发布态才拼 https://www.tumblr.com/{blog}/{id}。
    const published = state === 'published';
    return [{
      status: 'success',
      id,
      blog: host,
      state,
      url: published ? `${HOME}/${host}/${id}` : '',
    }];
  },
});

// 删除一篇帖（照官方 legacy 端点 POST /v2/blog/{blog}/post/delete，body 含 id）。
// 用于真机验证后清理测试内容，也作为独立原子能力暴露。
cli({
  site: 'tumblr',
  name: 'delete',
  access: 'write',
  description: 'Delete a Tumblr post by id (POST /v2/blog/{blog}/post/delete).',
  domain: 'tumblr.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'id', type: 'string', required: true, help: 'Post id to delete' },
    { name: 'blog', type: 'string', required: false, help: 'Target blog identifier (else your primary blog)' },
  ],
  columns: ['status', 'id', 'blog'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for tumblr delete');
    const id = String(kwargs.id ?? '').trim();
    if (!id) throw new ArgumentError('--id is required');

    await page.goto(DASHBOARD);
    const host = await resolveBlog(page, kwargs);

    const res = await apiFetch(page, `/v2/blog/${host}/post/delete`, { method: 'POST', body: { id } });
    if (res?.kind === 'auth') {
      throw new AuthRequiredError('tumblr.com', `Not logged in (${res.detail}). Run \`opencli tumblr login\`.`);
    }
    if (res?.kind === 'http') {
      throw new CommandExecutionError(`Tumblr delete failed: HTTP ${res.status} ${res.detail}`);
    }
    if (res?.kind !== 'ok') {
      throw new CommandExecutionError(`Unexpected Tumblr delete response: ${JSON.stringify(res)}`);
    }
    return [{ status: 'deleted', id, blog: host }];
  },
});

export const __test__ = { blogHost, resolveBody, buildContent, resolveTags };
