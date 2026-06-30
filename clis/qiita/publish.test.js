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

function mockFetch(routes) {
  calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, init });
    for (const [frag, handler] of routes) {
      if (String(url).includes(frag)) return handler(url, init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qiita-'));
  globalThis.__TOKEN_AUTH_HOME__ = home;
  saveCredentials('qiita', { token: 'tok-1' });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete globalThis.__TOKEN_AUTH_HOME__;
  delete globalThis.fetch;
});

describe('qiita whoami', () => {
  it('validates the stored token', async () => {
    mockFetch([['/authenticated_user', () => json(200, { id: 'alice', name: 'Alice' })]]);
    const whoami = getRegistry().get('qiita/whoami');
    await expect(whoami.func({})).resolves.toMatchObject({ logged_in: true, site: 'qiita', id: 'alice' });
    const me = calls.find((c) => String(c.url).includes('/authenticated_user'));
    expect(me.init.headers.Authorization).toBe('Bearer tok-1');
  });

  it('maps a 401 to AuthRequiredError', async () => {
    mockFetch([['/authenticated_user', () => json(401, { message: 'Unauthorized' })]]);
    const whoami = getRegistry().get('qiita/whoami');
    await expect(whoami.func({})).rejects.toThrow(AuthRequiredError);
  });
});

describe('qiita publish', () => {
  it('creates a public item with tags', async () => {
    mockFetch([['/items', () => json(201, { id: 'abc', url: 'https://qiita.com/alice/items/abc', private: false })]]);
    const publish = getRegistry().get('qiita/publish');
    const [row] = await publish.func({ title: 'T', body: 'B', tags: 'JavaScript, TypeScript', private: false });
    expect(row).toMatchObject({ status: 'created', id: 'abc', private: false });
    const sent = JSON.parse(calls.find((c) => String(c.url).endsWith('/items')).init.body);
    expect(sent.title).toBe('T');
    expect(sent.tags).toEqual([{ name: 'JavaScript', versions: [] }, { name: 'TypeScript', versions: [] }]);
    expect(sent.private).toBe(false);
  });

  it('updates via PATCH when --id given', async () => {
    mockFetch([['/items/abc', () => json(200, { id: 'abc', url: 'u', private: true })]]);
    const publish = getRegistry().get('qiita/publish');
    const [row] = await publish.func({ id: 'abc', body: 'B2', private: true });
    expect(row.status).toBe('updated');
    expect(calls.find((c) => String(c.url).includes('/items/abc')).init.method).toBe('PATCH');
  });

  it('requires tags when creating', async () => {
    mockFetch([]);
    const publish = getRegistry().get('qiita/publish');
    await expect(publish.func({ title: 'T', body: 'B' })).rejects.toThrow(/--tags is required/);
  });
});
