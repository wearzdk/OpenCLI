import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, AuthRequiredError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { buildArticle, resolveTagList, resolveBody } from './publish.js';
import './auth.js';

// [pp-only] devto 已从 token API 改成复用浏览器登录态。发布走页面内 fetch(POST /articles)，
// 这里测纯函数（标签/正文/article 组装）+ 用 mock page 走一遍发布编排。

describe('devto resolveTagList', () => {
  it('lowercases and joins into a comma string', () => {
    expect(resolveTagList('JavaScript, webdev')).toBe('javascript, webdev');
  });
  it('rejects >4 tags', () => {
    expect(() => resolveTagList('a,b,c,d,e')).toThrow(/Too many tags/);
  });
  it('rejects non-alphanumeric tags', () => {
    expect(() => resolveTagList('web dev')).toThrow(/lowercase alphanumeric/);
  });
  it('returns undefined for empty', () => {
    expect(resolveTagList('')).toBeUndefined();
    expect(resolveTagList(undefined)).toBeUndefined();
  });
});

describe('devto buildArticle', () => {
  it('maps args to snake_case Forem fields', () => {
    const a = buildArticle(
      { title: 'Hello', published: false, 'cover-image': 'https://img/x.png', 'canonical-url': 'https://me.dev/x', series: 'S', description: 'd' },
      '# Hi',
      'javascript, webdev',
    );
    expect(a).toEqual({
      title: 'Hello',
      body_markdown: '# Hi',
      published: false,
      tag_list: 'javascript, webdev',
      main_image: 'https://img/x.png',
      canonical_url: 'https://me.dev/x',
      series: 'S',
      description: 'd',
    });
  });
});

// mock page：goto + evaluate（evaluate 返回我们预设的 Forem 响应）
function mockPage(evalResult) {
  const calls = { evaluate: [] };
  return {
    calls,
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async (js) => { calls.evaluate.push(js); return evalResult; }),
  };
}

describe('devto publish (browser cookie)', () => {
  it('creates a draft via page fetch and hides the url for drafts', async () => {
    const page = mockPage({ kind: 'ok', data: { id: 42, current_state_path: '/karuha/x-42', slug: 'x-42' } });
    const publish = getRegistry().get('devto/publish');
    const [row] = await publish.func(page, { title: 'Hello', body: '# Hi', published: false });
    expect(row).toMatchObject({ status: 'created', id: 42, published: false, url: '' });
    expect(page.goto).toHaveBeenCalledWith('https://dev.to/');
    // article 体里带 csrf 头 + body_markdown
    expect(page.calls.evaluate[0]).toContain('X-CSRF-Token');
    expect(page.calls.evaluate[0]).toContain('body_markdown');
  });

  it('publishes live and surfaces the absolute url', async () => {
    const page = mockPage({ kind: 'ok', data: { id: 42, current_state_path: '/karuha/x-42', slug: 'x-42' } });
    const publish = getRegistry().get('devto/publish');
    const [row] = await publish.func(page, { title: 'Hello', body: '# Hi', published: true });
    expect(row).toMatchObject({ status: 'created', published: true, url: 'https://dev.to/karuha/x-42' });
  });

  it('updates via id (PUT path) when --id given', async () => {
    const page = mockPage({ kind: 'ok', data: { id: 42, slug: 'x-42' } });
    const publish = getRegistry().get('devto/publish');
    const [row] = await publish.func(page, { id: '42', body: 'updated' });
    expect(row.status).toBe('updated');
    expect(page.calls.evaluate[0]).toContain('/articles/42');
    expect(page.calls.evaluate[0]).toContain('"PUT"');
  });

  it('maps an auth response to AuthRequiredError', async () => {
    const page = mockPage({ kind: 'auth', detail: 'HTTP 401' });
    const publish = getRegistry().get('devto/publish');
    await expect(publish.func(page, { title: 't', body: 'b' })).rejects.toThrow(AuthRequiredError);
  });

  it('requires title and body when creating', async () => {
    const page = mockPage({ kind: 'ok', data: {} });
    const publish = getRegistry().get('devto/publish');
    await expect(publish.func(page, { body: 'b' })).rejects.toThrow(/--title is required/);
    await expect(publish.func(page, { title: 't' })).rejects.toThrow(/--body/);
  });

  it('rejects >4 tags before any page call', async () => {
    const page = mockPage({ kind: 'ok', data: {} });
    const publish = getRegistry().get('devto/publish');
    await expect(publish.func(page, { title: 't', body: 'b', tags: 'a,b,c,d,e' })).rejects.toThrow(/Too many tags/);
    expect(page.goto).not.toHaveBeenCalled();
  });
});
