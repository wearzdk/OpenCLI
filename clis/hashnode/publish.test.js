import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { saveCredentials } from '../_shared/token-auth.js';
import './auth.js';
import './publish.js';

vi.mock('node:os', async (orig) => {
  const actual = await orig();
  return { ...actual, homedir: () => globalThis.__TOKEN_AUTH_HOME__ };
});

let home;
let calls;

// 每个 fetch 都打到同一 GraphQL 端点，按请求 body 里的 query 关键字路由。
function mockGql(handler) {
  calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push({ url, init, payload });
    const body = handler(payload);
    return { ok: true, status: 200, json: async () => body };
  });
}
const data = (d) => ({ data: d });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hashnode-'));
  globalThis.__TOKEN_AUTH_HOME__ = home;
  saveCredentials('hashnode', { token: 'pat-1' });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete globalThis.__TOKEN_AUTH_HOME__;
  delete globalThis.fetch;
});

describe('hashnode whoami', () => {
  it('validates the stored PAT', async () => {
    mockGql(() => data({ me: { id: 'u1', username: 'alice', name: 'Alice' } }));
    const whoami = getRegistry().get('hashnode/whoami');
    await expect(whoami.func({})).resolves.toMatchObject({ logged_in: true, site: 'hashnode', id: 'u1', username: 'alice' });
    expect(calls[0].init.headers.Authorization).toBe('pat-1');
  });

  it('maps a GraphQL auth error to AuthRequiredError', async () => {
    calls = [];
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'Not authenticated' }] }) }));
    const whoami = getRegistry().get('hashnode/whoami');
    await expect(whoami.func({})).rejects.toThrow(AuthRequiredError);
  });
});

describe('hashnode publish', () => {
  it('auto-resolves the sole publication and publishes with tags + cover', async () => {
    mockGql((p) => {
      if (p.query.includes('publications')) return data({ me: { publications: { edges: [{ node: { id: 'pub1', title: 'Blog', url: 'https://b.dev' } }] } } });
      if (p.query.includes('publishPost')) return data({ publishPost: { post: { id: 'p1', slug: 'hello', url: 'https://b.dev/hello' } } });
      throw new Error('unexpected query');
    });
    const publish = getRegistry().get('hashnode/publish');
    const [row] = await publish.func({ title: 'Hello', body: '# hi', tags: 'Web Dev, JS', 'cover-image': 'https://img/x.png', 'canonical-url': 'https://me/x' });
    expect(row).toMatchObject({ status: 'published', id: 'p1', slug: 'hello' });
    const input = calls.find((c) => c.payload.query.includes('publishPost')).payload.variables.input;
    expect(input.publicationId).toBe('pub1');
    expect(input.tags).toEqual([{ slug: 'web-dev', name: 'Web Dev' }, { slug: 'js', name: 'JS' }]);
    expect(input.coverImageOptions).toEqual({ coverImageURL: 'https://img/x.png' });
    expect(input.originalArticleURL).toBe('https://me/x');
  });

  it('errors when multiple publications and none specified', async () => {
    mockGql(() => data({ me: { publications: { edges: [
      { node: { id: 'a', title: 'A', url: 'ua' } }, { node: { id: 'b', title: 'B', url: 'ub' } },
    ] } } }));
    const publish = getRegistry().get('hashnode/publish');
    await expect(publish.func({ title: 'T', body: 'b' })).rejects.toThrow(/Multiple publications/);
  });

  it('uses --publication-id without a lookup and saves a draft with --draft', async () => {
    mockGql((p) => {
      if (p.query.includes('createDraft')) return data({ createDraft: { draft: { id: 'd1', slug: 's1' } } });
      throw new Error('unexpected query: ' + p.query);
    });
    const publish = getRegistry().get('hashnode/publish');
    const [row] = await publish.func({ title: 'T', body: 'b', 'publication-id': 'pubX', draft: true });
    expect(row).toMatchObject({ status: 'draft', id: 'd1', slug: 's1' });
    // 只调用了 createDraft，没有 publications 解析
    expect(calls.every((c) => !c.payload.query.includes('publications'))).toBe(true);
    expect(calls.find((c) => c.payload.query.includes('createDraft')).payload.variables.input.publicationId).toBe('pubX');
  });
});
