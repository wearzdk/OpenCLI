import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { saveCredentials } from '../_shared/token-auth.js';
import { oauth1Header } from './auth.js';
import './auth.js';
import './publish.js';

vi.mock('node:os', async (orig) => {
  const actual = await orig();
  return { ...actual, homedir: () => globalThis.__TOKEN_AUTH_HOME__ };
});

let home;
let calls;

const CREDS = {
  consumer_key: 'ck', consumer_secret: 'cs', oauth_token: 'ot', oauth_token_secret: 'ots', default_blog: 'myblog',
};

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tumblr-'));
  globalThis.__TOKEN_AUTH_HOME__ = home;
  saveCredentials('tumblr', CREDS);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete globalThis.__TOKEN_AUTH_HOME__;
  delete globalThis.fetch;
});

describe('oauth1Header', () => {
  it('emits a well-formed OAuth1 HMAC-SHA1 header with a fresh nonce each call', () => {
    const url = 'https://api.tumblr.com/v2/blog/myblog.tumblr.com/posts';
    const h1 = oauth1Header('POST', url, CREDS);
    const h2 = oauth1Header('POST', url, CREDS);
    expect(h1).toMatch(/^OAuth /);
    expect(h1).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(h1).toContain('oauth_consumer_key="ck"');
    expect(h1).toContain('oauth_token="ot"');
    const sig = /oauth_signature="([^"]+)"/.exec(h1)[1];
    expect(decodeURIComponent(sig).length).toBeGreaterThan(10);
    // nonce 每次随机 → 两次签名不同（防签名被固定/复用）。
    const nonce1 = /oauth_nonce="([^"]+)"/.exec(h1)[1];
    const nonce2 = /oauth_nonce="([^"]+)"/.exec(h2)[1];
    expect(nonce1).not.toBe(nonce2);
  });
});

describe('tumblr whoami', () => {
  it('validates and lists blogs', async () => {
    mockFetch([['/user/info', () => json(200, { response: { user: { name: 'alice', blogs: [
      { name: 'myblog', primary: true }, { name: 'side' },
    ] } } })]]);
    const whoami = getRegistry().get('tumblr/whoami');
    await expect(whoami.func({})).resolves.toMatchObject({ logged_in: true, site: 'tumblr', name: 'alice', blogs: 'myblog,side', default_blog: 'myblog' });
    expect(calls[0].init.headers.Authorization).toMatch(/^OAuth /);
  });

  it('maps a 401 to AuthRequiredError', async () => {
    mockFetch([['/user/info', () => json(401, { meta: { msg: 'Unauthorized' } })]]);
    const whoami = getRegistry().get('tumblr/whoami');
    await expect(whoami.func({})).rejects.toThrow(AuthRequiredError);
  });
});

describe('tumblr post', () => {
  it('creates an NPF text post on the default blog with tags', async () => {
    mockFetch([['/posts', () => json(201, { response: { id: 12345, id_string: '12345' } })]]);
    const post = getRegistry().get('tumblr/post');
    const [row] = await post.func({ text: 'hello tumblr', tags: 'art, photo' });
    expect(row).toMatchObject({ status: 'success', id: '12345', blog: 'myblog.tumblr.com', state: 'published', url: 'https://myblog.tumblr.com/post/12345' });
    const req = calls.find((c) => String(c.url).includes('/posts'));
    const sent = JSON.parse(req.init.body);
    expect(sent.content).toEqual([{ type: 'text', text: 'hello tumblr' }]);
    expect(sent.tags).toBe('art,photo');
    expect(sent.state).toBe('published');
    // 命中 default_blog 的 host
    expect(String(req.url)).toContain('/blog/myblog.tumblr.com/posts');
  });

  it('honors --blog and --state draft and an image-url block', async () => {
    mockFetch([['/posts', () => json(201, { response: { id_string: '9' } })]]);
    const post = getRegistry().get('tumblr/post');
    const [row] = await post.func({ 'image-url': 'https://img/x.png', blog: 'other', state: 'draft' });
    expect(row.blog).toBe('other.tumblr.com');
    expect(row.state).toBe('draft');
    const sent = JSON.parse(calls.find((c) => String(c.url).includes('/posts')).init.body);
    expect(sent.content).toEqual([{ type: 'image', media: [{ url: 'https://img/x.png' }] }]);
  });

  it('rejects empty content and invalid state before any network call', async () => {
    mockFetch([]);
    const post = getRegistry().get('tumblr/post');
    await expect(post.func({})).rejects.toThrow(/at least one of/);
    await expect(post.func({ text: 'x', state: 'bogus' })).rejects.toThrow(/Invalid --state/);
  });
});
