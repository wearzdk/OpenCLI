import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { resolveBody, resolveTagNames } from './publish.js';
import './publish.js';

// 浏览器 cookie 型，不再有 token：用 mock page 驱动 func，断言它发出的 GraphQL / 删除请求。
// mock page.evaluate 拦截页面内 fetch：按请求体里的 operation 关键字返回造好的 JSON（模拟服务端）。

/**
 * 造一个 mock page：goto / wait 记账；evaluate 把页面内那段 IIFE 当作「调用了 fetch」，
 * 但因为我们不真跑浏览器，所以直接按 capture 的 GraphQL body 返回。
 * 实现方式：func 里的 qiitaGql 把 query/variables 通过 JSON.stringify 拼进 evaluate 字符串，
 * 我们从该字符串里解析出 operation 名与 variables，再交给 routes 决定返回什么。
 */
function makePage(routes) {
  const evalCalls = [];
  return {
    evalCalls,
    async goto() {},
    async wait() {},
    async getCookies() { return [{ name: '_qiita_login_session', value: 'sess' }]; },
    async evaluate(jsString) {
      evalCalls.push(jsString);
      // gql.js 的 evaluate：含 'X-CSRF-Token' 与 GraphQL fetch
      if (jsString.includes("'X-CSRF-Token'") || jsString.includes('"X-CSRF-Token"')) {
        // 从拼进字符串的 JSON.stringify(query) 里识别 operation
        const op = jsString.includes('saveCreatingArticle') ? 'save'
          : jsString.includes('publishPublicArticle') ? 'public'
            : jsString.includes('publishSecretArticle') ? 'secret'
              : 'viewer';
        const body = routes[op];
        if (!body) throw new Error(`no mock route for op=${op}`);
        return { kind: 'ok', body };
      }
      // qiitaDeleteByForm 的 evaluate：含 _method=delete
      if (jsString.includes('_method=delete')) {
        return routes.delete ?? { kind: 'done', ok: true, status: 0 };
      }
      throw new Error(`unexpected evaluate: ${jsString.slice(0, 60)}`);
    },
  };
}

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qiita-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('resolveTagNames', () => {
  it('splits comma-separated tags and trims', () => {
    expect(resolveTagNames('JavaScript, TypeScript ,Go')).toEqual(['JavaScript', 'TypeScript', 'Go']);
  });
  it('drops empty entries', () => {
    expect(resolveTagNames(' , a ,, b ,')).toEqual(['a', 'b']);
  });
  it('returns empty array for nullish', () => {
    expect(resolveTagNames(undefined)).toEqual([]);
    expect(resolveTagNames('')).toEqual([]);
  });
});

describe('resolveBody', () => {
  it('returns --body verbatim', () => {
    expect(resolveBody({ body: '# Hello' })).toBe('# Hello');
  });
  it('reads --body-file', () => {
    const f = path.join(home, 'b.md');
    fs.writeFileSync(f, 'from file');
    expect(resolveBody({ 'body-file': f })).toBe('from file');
  });
  it('throws on missing --body-file', () => {
    expect(() => resolveBody({ 'body-file': path.join(home, 'nope.md') })).toThrow(ArgumentError);
  });
  it('returns undefined when neither given', () => {
    expect(resolveBody({})).toBeUndefined();
  });
});

describe('qiita publish (browser/cookie)', () => {
  const draftReply = { data: { saveCreatingArticle: { draftItem: { uuid: 'srv-uuid' } } } };

  it('saves with empty uuid then publishes public; first save uuid must be ""', async () => {
    const page = makePage({
      save: draftReply,
      public: { data: { publishPublicArticle: { article: { uuid: 'srv-uuid', linkUrl: 'https://qiita.com/me/items/srv-uuid', isSecret: false } } } },
    });
    const publish = getRegistry().get('qiita/publish');
    const [row] = await publish.func(page, { title: 'T', body: 'B', tags: 'test' });
    expect(row).toMatchObject({ status: 'published', uuid: 'srv-uuid', url: 'https://qiita.com/me/items/srv-uuid' });
    // 第一次 GraphQL 调用必须是 saveCreatingArticle 且 uuid 传空串（铁律：不能自造 uuid）
    const saveCall = page.evalCalls.find((s) => s.includes('saveCreatingArticle'));
    expect(saveCall).toContain('"uuid":""');
    // 公开发布必须带非空 tweetShare / adventCalendarItems
    const pubCall = page.evalCalls.find((s) => s.includes('publishPublicArticle'));
    expect(pubCall).toContain('"tweetShare"');
    expect(pubCall).toContain('"adventCalendarItems"');
    // 公开发布用的是服务端回的 uuid，而非空串
    expect(pubCall).toContain('"uuid":"srv-uuid"');
  });

  it('--draft stops after save and returns the draft edit url', async () => {
    const page = makePage({ save: draftReply });
    const publish = getRegistry().get('qiita/publish');
    const [row] = await publish.func(page, { title: 'T', body: 'B', tags: 'test', draft: true });
    expect(row).toMatchObject({ status: 'draft', uuid: 'srv-uuid', url: 'https://qiita.com/drafts/srv-uuid/edit' });
    expect(page.evalCalls.some((s) => s.includes('publishPublicArticle'))).toBe(false);
  });

  it('--secret publishes via publishSecretArticle without tweetShare', async () => {
    const page = makePage({
      save: draftReply,
      secret: { data: { publishSecretArticle: { article: { uuid: 'srv-uuid', linkUrl: 'https://qiita.com/me/items/srv-uuid', isSecret: true } } } },
    });
    const publish = getRegistry().get('qiita/publish');
    const [row] = await publish.func(page, { title: 'T', body: 'B', tags: 'test', secret: true });
    expect(row).toMatchObject({ status: 'published-secret', url: 'https://qiita.com/me/items/srv-uuid' });
    const secCall = page.evalCalls.find((s) => s.includes('publishSecretArticle'));
    expect(secCall).not.toContain('tweetShare');
  });

  it('requires --tags', async () => {
    const page = makePage({});
    const publish = getRegistry().get('qiita/publish');
    await expect(publish.func(page, { title: 'T', body: 'B' })).rejects.toThrow(/--tags is required/);
  });

  it('requires --title', async () => {
    const page = makePage({});
    const publish = getRegistry().get('qiita/publish');
    await expect(publish.func(page, { body: 'B', tags: 'test' })).rejects.toThrow(/--title is required/);
  });

  it('throws when save returns no uuid', async () => {
    const page = makePage({ save: { data: { saveCreatingArticle: { draftItem: {} } } } });
    const publish = getRegistry().get('qiita/publish');
    await expect(publish.func(page, { title: 'T', body: 'B', tags: 'test', draft: true }))
      .rejects.toThrow(CommandExecutionError);
  });
});

describe('qiita delete (browser/cookie)', () => {
  it('deletes by url via the Rails form post', async () => {
    const page = makePage({ delete: { kind: 'done', ok: true, status: 0 } });
    const del = getRegistry().get('qiita/delete');
    const [row] = await del.func(page, { url: 'https://qiita.com/me/items/abc' });
    expect(row).toMatchObject({ status: 'deleted', url: 'https://qiita.com/me/items/abc' });
    expect(page.evalCalls.some((s) => s.includes('_method=delete'))).toBe(true);
  });

  it('rejects a non-qiita url', async () => {
    const page = makePage({});
    const del = getRegistry().get('qiita/delete');
    await expect(del.func(page, { url: 'https://evil.example/x' })).rejects.toThrow(ArgumentError);
  });

  it('throws when the delete request fails', async () => {
    const page = makePage({ delete: { kind: 'done', ok: false, status: 422 } });
    const del = getRegistry().get('qiita/delete');
    await expect(del.func(page, { url: 'https://qiita.com/drafts/abc' })).rejects.toThrow(CommandExecutionError);
  });
});
