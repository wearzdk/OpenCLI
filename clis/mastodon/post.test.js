import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { saveCredentials } from '../_shared/token-auth.js';
import './auth.js';
import './post.js';

vi.mock('node:os', async (orig) => {
  const actual = await orig();
  return { ...actual, homedir: () => globalThis.__TOKEN_AUTH_HOME__ };
});

let home;
let calls;
function mockFetch(routes) {
  calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [frag, handler] of routes) if (String(url).includes(frag)) return handler(url, init);
    throw new Error(`unexpected fetch: ${url}`);
  });
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ACCOUNT = json(200, { id: '99', username: 'alice', acct: 'alice' });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'masto-'));
  globalThis.__TOKEN_AUTH_HOME__ = home;
  saveCredentials('mastodon', { instance: 'https://mastodon.social', token: 'tok-1' });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete globalThis.__TOKEN_AUTH_HOME__;
  delete globalThis.fetch;
});

describe('mastodon whoami', () => {
  it('verifies credentials and reports instance + acct', async () => {
    mockFetch([['verify_credentials', () => ACCOUNT]]);
    const whoami = getRegistry().get('mastodon/whoami');
    await expect(whoami.func({})).resolves.toMatchObject({
      logged_in: true, id: '99', username: 'alice', acct: 'alice', instance: 'https://mastodon.social',
    });
  });
  it('maps 401 to AuthRequiredError', async () => {
    mockFetch([['verify_credentials', () => json(401, { error: 'invalid' })]]);
    await expect(getRegistry().get('mastodon/whoami').func({})).rejects.toThrow(AuthRequiredError);
  });
});

describe('mastodon post', () => {
  it('posts text-only with visibility', async () => {
    mockFetch([['/api/v1/statuses', () => json(200, { id: '1001', url: 'https://mastodon.social/@alice/1001' })]]);
    const [row] = await getRegistry().get('mastodon/post').func({ text: 'hi fedi', visibility: 'unlisted' });
    expect(row).toEqual({ status: 'success', id: '1001', url: 'https://mastodon.social/@alice/1001' });
    const body = JSON.parse(calls.find((c) => c.url.includes('/api/v1/statuses')).init.body);
    expect(body).toMatchObject({ status: 'hi fedi', visibility: 'unlisted' });
    expect(body.media_ids).toBeUndefined();
    const idem = calls.find((c) => c.url.includes('/api/v1/statuses')).init.headers['Idempotency-Key'];
    expect(idem).toMatch(/^pp-/);
  });

  it('uploads media then attaches media_ids', async () => {
    const img = path.join(home, 'p.png'); fs.writeFileSync(img, Buffer.from([1, 2, 3]));
    mockFetch([
      ['/api/v2/media', () => json(200, { id: 'm1' })],
      ['/api/v1/statuses', () => json(200, { id: '1002', url: 'https://mastodon.social/@alice/1002' })],
    ]);
    const [row] = await getRegistry().get('mastodon/post').func({ text: 'pic', media: img, alt: 'desc' });
    expect(row.status).toBe('success');
    const upload = calls.find((c) => c.url.includes('/api/v2/media'));
    expect(upload.init.body.get('description')).toBe('desc');
    expect(upload.init.body.get('file')).toBeInstanceOf(Blob);
    const body = JSON.parse(calls.find((c) => c.url.includes('/api/v1/statuses')).init.body);
    expect(body.media_ids).toEqual(['m1']);
  });

  it('polls a 202 media until processed', async () => {
    const img = path.join(home, 'p.png'); fs.writeFileSync(img, Buffer.from([1]));
    let polled = 0;
    mockFetch([
      ['/api/v2/media', () => json(202, { id: 'm2' })],
      ['/api/v1/media/m2', () => { polled += 1; return json(200, { id: 'm2', url: 'x' }); }],
      ['/api/v1/statuses', () => json(200, { id: '1', url: 'u' })],
    ]);
    const [row] = await getRegistry().get('mastodon/post').func({ text: 't', media: img });
    expect(row.status).toBe('success');
    expect(polled).toBeGreaterThanOrEqual(1);
  });

  it('rejects an invalid visibility', async () => {
    mockFetch([]);
    await expect(getRegistry().get('mastodon/post').func({ text: 'x', visibility: 'secret' })).rejects.toThrow(/visibility/);
  });
});
