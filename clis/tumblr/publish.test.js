import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import './auth.js';
import { __test__ } from './publish.js';
import './publish.js';

const { blogHost, resolveBody, buildContent, resolveTags } = __test__;

// ---- 纯函数 ----

describe('blogHost', () => {
  it('裸名补成 .tumblr.com，含点的自定义域原样保留', () => {
    expect(blogHost('myblog')).toBe('myblog.tumblr.com');
    expect(blogHost('myblog.tumblr.com')).toBe('myblog.tumblr.com');
    expect(blogHost('blog.example.com')).toBe('blog.example.com');
    expect(blogHost('  spaced ')).toBe('spaced.tumblr.com');
    expect(blogHost('')).toBe('');
  });
});

describe('resolveBody', () => {
  const tmps = [];
  afterEach(() => { for (const f of tmps.splice(0)) fs.rmSync(f, { force: true }); });

  it('--body-file 优先，其次 --body，再次 --text', () => {
    const f = path.join(os.tmpdir(), `tumblr-body-${Date.now()}.txt`);
    fs.writeFileSync(f, 'from file'); tmps.push(f);
    expect(resolveBody({ 'body-file': f, body: 'b', text: 't' })).toBe('from file');
    expect(resolveBody({ body: 'b', text: 't' })).toBe('b');
    expect(resolveBody({ text: 't' })).toBe('t');
    expect(resolveBody({})).toBeUndefined();
  });

  it('--body-file 不存在时抛 ArgumentError', () => {
    expect(() => resolveBody({ 'body-file': '/nope/missing.txt' })).toThrow(ArgumentError);
  });
});

describe('buildContent', () => {
  it('标题→heading1，正文按空行拆段，附图片/链接块', () => {
    const content = buildContent(
      { title: 'T', 'image-url': 'https://img/x.png', link: 'https://l/y' },
      '第一段\n\n第二段',
    );
    expect(content).toEqual([
      { type: 'text', subtype: 'heading1', text: 'T' },
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
      { type: 'image', media: [{ url: 'https://img/x.png' }] },
      { type: 'link', url: 'https://l/y' },
    ]);
  });

  it('空内容抛 ArgumentError', () => {
    expect(() => buildContent({}, undefined)).toThrow(ArgumentError);
    expect(() => buildContent({}, '   ')).toThrow(ArgumentError);
  });
});

describe('resolveTags', () => {
  it('逗号分隔去空白去空项后拼回', () => {
    expect(resolveTags('art, photo ,, draw')).toBe('art,photo,draw');
    expect(resolveTags('')).toBe('');
    expect(resolveTags(undefined)).toBe('');
  });
});

// ---- 命令（mock page，apiFetch 跑在 page.evaluate 内，这里拦截 evaluate）----

// 模拟一个 page：evaluate 接收 JS 字符串，但我们不真跑浏览器，按调用序号返回桩数据。
function mockPage(evalResults) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async goto() {},
    async evaluate(script) {
      calls.push(script);
      const r = evalResults[i++];
      if (typeof r === 'function') return r(script);
      return r;
    },
  };
}

const userInfoOk = { kind: 'ok', response: { user: { blogs: [{ name: 'myblog', primary: true }, { name: 'side' }] } }, meta: null };

describe('tumblr publish', () => {
  it('默认状态 draft，自动取主博客，content/state/tags 正确，草稿不回报 url', async () => {
    const page = mockPage([
      userInfoOk, // resolveBlog → /v2/user/info
      { kind: 'ok', response: { id_string: '12345' }, meta: null }, // 建帖
    ]);
    const publish = getRegistry().get('tumblr/publish');
    const [row] = await publish.func(page, { title: 'Hi', text: '正文', tags: 'art, photo' });
    expect(row).toMatchObject({ status: 'success', id: '12345', blog: 'myblog.tumblr.com', state: 'draft', url: '' });
    // 建帖 evaluate 脚本里应包含目标 host、content、state、tags
    const postScript = page.calls[1];
    expect(postScript).toContain('/v2/blog/myblog.tumblr.com/posts');
    expect(postScript).toContain('"state":"draft"');
    expect(postScript).toContain('"tags":"art,photo"');
    expect(postScript).toContain('"subtype":"heading1"');
  });

  it('--state published 回报公开 url；--blog 覆盖目标博客（不查 user/info）', async () => {
    const page = mockPage([
      { kind: 'ok', response: { id_string: '9' }, meta: null }, // 建帖（直接，无 user/info）
    ]);
    const publish = getRegistry().get('tumblr/publish');
    const [row] = await publish.func(page, { text: 'x', blog: 'other', state: 'published' });
    expect(row).toMatchObject({ status: 'success', id: '9', blog: 'other.tumblr.com', state: 'published', url: 'https://www.tumblr.com/other.tumblr.com/9' });
    expect(page.calls[0]).toContain('/v2/blog/other.tumblr.com/posts');
  });

  it('空内容 / 非法 state 在任何网络调用前抛错', async () => {
    const publish = getRegistry().get('tumblr/publish');
    await expect(publish.func(mockPage([]), { blog: 'b' })).rejects.toThrow(/at least one of/);
    await expect(publish.func(mockPage([]), { text: 'x', state: 'bogus' })).rejects.toThrow(/Invalid --state/);
  });

  it('apiFetch 返回 auth → AuthRequiredError', async () => {
    const page = mockPage([{ kind: 'auth', detail: 'HTTP 401' }]);
    const publish = getRegistry().get('tumblr/publish');
    await expect(publish.func(page, { text: 'x', blog: 'b' })).rejects.toThrow(AuthRequiredError);
  });

  it('apiFetch 返回 http 错误 → CommandExecutionError', async () => {
    const page = mockPage([{ kind: 'http', status: 400, detail: 'bad' }]);
    const publish = getRegistry().get('tumblr/publish');
    await expect(publish.func(page, { text: 'x', blog: 'b' })).rejects.toThrow(CommandExecutionError);
  });
});

describe('tumblr delete', () => {
  it('用主博客删帖，命中 post/delete 端点并带 id', async () => {
    const page = mockPage([
      userInfoOk, // resolveBlog
      { kind: 'ok', response: {}, meta: null }, // delete
    ]);
    const del = getRegistry().get('tumblr/delete');
    const [row] = await del.func(page, { id: '777' });
    expect(row).toMatchObject({ status: 'deleted', id: '777', blog: 'myblog.tumblr.com' });
    const delScript = page.calls[1];
    expect(delScript).toContain('/v2/blog/myblog.tumblr.com/post/delete');
    expect(delScript).toContain('"id":"777"');
  });

  it('缺 --id 抛 ArgumentError', async () => {
    const del = getRegistry().get('tumblr/delete');
    await expect(del.func(mockPage([]), {})).rejects.toThrow(ArgumentError);
  });
});
