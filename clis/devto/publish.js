import * as fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

// dev.to 文章发布 / 更新 —— [pp-only] 复用浏览器登录态，打 Forem web 编辑器自己用的内部路由：
//   POST /articles（新建）/ PUT /articles/{id}（更新），JSON body 外包 { article: {...} }，
//   靠页面 `meta[name=csrf-token]` 的 X-CSRF-Token + 登录 cookie 鉴权（credentials:'include'）。
// 不再走官方 /api/articles + api-key。字段白名单与 camel/snake 归一见 Forem
// ArticlesController#article_params_json（transform_keys!(:underscore)）。
// 原子能力：md 正文、草稿↔published、封面图(main_image)、tags(≤4)、canonical_url、series、description。

const MAX_TAGS = 4;

export function resolveBody(kwargs) {
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

// dev.to 标签：小写、仅字母数字、最多 4 个。返回逗号分隔字符串（web 端 tag_list 形态）。
export function resolveTagList(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const tags = String(raw).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length > MAX_TAGS) throw new ArgumentError(`Too many tags: ${tags.length} (DEV.to max ${MAX_TAGS})`);
  for (const t of tags) {
    if (!/^[a-z0-9]+$/.test(t)) {
      throw new ArgumentError(`Invalid tag "${t}". DEV.to tags must be lowercase alphanumeric (no spaces/punctuation).`);
    }
  }
  return tags.join(', ');
}

// 组装提交给 Forem 的 article 对象（snake_case，对齐服务端白名单）。纯函数，便于测试。
export function buildArticle(kwargs, body, tagList) {
  const article = {};
  if (kwargs.title !== undefined) article.title = String(kwargs.title);
  if (body !== undefined) article.body_markdown = body;
  if (kwargs.published !== undefined) article.published = !!kwargs.published;
  if (tagList !== undefined) article.tag_list = tagList;
  if (kwargs['cover-image']) article.main_image = String(kwargs['cover-image']);
  if (kwargs['canonical-url']) article.canonical_url = String(kwargs['canonical-url']);
  if (kwargs.series) article.series = String(kwargs.series);
  if (kwargs.description) article.description = String(kwargs.description);
  return article;
}

cli({
  site: 'devto',
  name: 'publish',
  access: 'write',
  description: 'Publish or update a DEV.to article (markdown). Draft by default; pass --published to go live.',
  domain: 'dev.to',
  strategy: Strategy.COOKIE,
  browser: true,
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
    { name: 'id', type: 'string', required: false, help: 'Existing article id to update (PUT instead of POST)' },
  ],
  columns: ['status', 'id', 'url', 'published', 'slug'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for devto publish');
    const id = kwargs.id ? String(kwargs.id).trim() : '';
    const body = resolveBody(kwargs);
    const tagList = resolveTagList(kwargs.tags);

    if (!id && !kwargs.title) throw new ArgumentError('--title is required when creating a new article');
    if (!id && body === undefined) throw new ArgumentError('--body or --body-file is required when creating a new article');

    const article = buildArticle(kwargs, body, tagList);
    const method = id ? 'PUT' : 'POST';
    const path = id ? `/articles/${encodeURIComponent(id)}` : '/articles';

    // 打开已登录的 dev.to（同源，带 csrf meta 与 cookie），在页面内提交。
    await page.goto('https://dev.to/');
    const res = await page.evaluate(`(async () => {
      try {
        var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || window.csrfToken;
        if (!csrf) return { kind: 'auth', detail: 'no csrf-token meta — not logged in?' };
        var r = await fetch(${JSON.stringify(path)}, {
          method: ${JSON.stringify(method)},
          credentials: 'include',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ article: ${JSON.stringify(article)} }),
        });
        var text = await r.text();
        var data = null; try { data = JSON.parse(text); } catch (e) {}
        if (r.status === 401 || r.status === 403) return { kind: 'auth', detail: 'HTTP ' + r.status };
        if (!r.ok) return { kind: 'http', status: r.status, detail: text.slice(0, 300) };
        return { kind: 'ok', data: data };
      } catch (e) { return { kind: 'exception', detail: String(e && e.message || e) }; }
    })()`);

    if (res?.kind === 'auth') throw new AuthRequiredError('dev.to', `Not logged in (${res.detail}). Run \`opencli devto login\`.`);
    if (res?.kind === 'http') throw new CommandExecutionError(`dev.to publish failed: HTTP ${res.status} ${res.detail}`);
    if (res?.kind === 'exception') throw new CommandExecutionError(`dev.to publish error: ${res.detail}`);
    if (res?.kind !== 'ok' || !res.data) throw new CommandExecutionError(`Unexpected dev.to response: ${JSON.stringify(res)}`);

    const data = res.data;
    // 响应：{ id, current_state_path }（current_state_path 发布态即 /{user}/{slug}）。
    const published = !!article.published;
    let url = '';
    if (data.current_state_path) {
      try { url = new URL(data.current_state_path, 'https://dev.to').href; } catch (e) { url = String(data.current_state_path); }
    } else if (data.url) {
      url = String(data.url);
    }
    return [{
      status: id ? 'updated' : 'created',
      id: data.id ?? '',
      url: published ? url : '', // 草稿无公开 URL，不回报半成品链接
      published,
      slug: data.slug ?? '',
    }];
  },
});
