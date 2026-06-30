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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devto-'));
  globalThis.__TOKEN_AUTH_HOME__ = home;
  saveCredentials('devto', { api_key: 'key-abc' });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete globalThis.__TOKEN_AUTH_HOME__;
  delete globalThis.fetch;
});

describe('devto whoami', () => {
  it('validates the stored api key', async () => {
    mockFetch([['/users/me', () => json(200, { id: 7, username: 'alice', name: 'Alice' })]]);
    const whoami = getRegistry().get('devto/whoami');
    await expect(whoami.func({})).resolves.toMatchObject({ logged_in: true, site: 'devto', id: 7, username: 'alice' });
    const me = calls.find((c) => String(c.url).includes('/users/me'));
    expect(me.init.headers['api-key']).toBe('key-abc');
  });

  it('maps a 401 to AuthRequiredError', async () => {
    mockFetch([['/users/me', () => json(401, { error: 'unauthorized' })]]);
    const whoami = getRegistry().get('devto/whoami');
    await expect(whoami.func({})).rejects.toThrow(AuthRequiredError);
  });
});

describe('devto publish', () => {
  it('creates a draft article with cover, tags, canonical and series', async () => {
    mockFetch([['/articles', () => json(201, { id: 42, url: 'https://dev.to/alice/x-42', published: false, slug: 'x-42' })]]);
    const publish = getRegistry().get('devto/publish');
    const [row] = await publish.func({
      title: 'Hello', body: '# Hi', published: false, tags: 'JavaScript, webdev',
      'cover-image': 'https://img/x.png', 'canonical-url': 'https://me.dev/x', series: 'My Series',
    });
    expect(row).toMatchObject({ status: 'created', id: 42, published: false, slug: 'x-42' });
    const sent = JSON.parse(calls.find((c) => String(c.url).endsWith('/articles')).init.body).article;
    expect(sent.title).toBe('Hello');
    expect(sent.body_markdown).toBe('# Hi');
    expect(sent.published).toBe(false);
    expect(sent.tags).toEqual(['javascript', 'webdev']); // lowercased
    expect(sent.main_image).toBe('https://img/x.png');
    expect(sent.canonical_url).toBe('https://me.dev/x');
    expect(sent.series).toBe('My Series');
  });

  it('publishes live when --published is set and updates via PUT when --id given', async () => {
    mockFetch([['/articles/42', () => json(200, { id: 42, url: 'https://dev.to/alice/x-42', published: true, slug: 'x-42' })]]);
    const publish = getRegistry().get('devto/publish');
    const [row] = await publish.func({ id: '42', body: 'updated', published: true });
    expect(row.status).toBe('updated');
    expect(row.published).toBe(true);
    const req = calls.find((c) => String(c.url).includes('/articles/42'));
    expect(req.init.method).toBe('PUT');
  });

  it('rejects >4 tags before any network call', async () => {
    mockFetch([]);
    const publish = getRegistry().get('devto/publish');
    await expect(publish.func({ title: 't', body: 'b', tags: 'a,b,c,d,e' })).rejects.toThrow(/Too many tags/);
  });

  it('rejects an invalid (non-alphanumeric) tag', async () => {
    mockFetch([]);
    const publish = getRegistry().get('devto/publish');
    await expect(publish.func({ title: 't', body: 'b', tags: 'web dev' })).rejects.toThrow(/lowercase alphanumeric/);
  });

  it('requires title and body when creating', async () => {
    mockFetch([]);
    const publish = getRegistry().get('devto/publish');
    await expect(publish.func({ body: 'b' })).rejects.toThrow(/--title is required/);
    await expect(publish.func({ title: 't' })).rejects.toThrow(/--body/);
  });
});
