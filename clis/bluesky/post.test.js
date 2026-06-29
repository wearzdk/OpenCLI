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
    calls.push({ url, init });
    for (const [frag, handler] of routes) {
      if (String(url).includes(frag)) return handler(url, init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const SESSION = json(200, { accessJwt: 'jwt-123', did: 'did:plc:alice', handle: 'alice.bsky.social' });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bsky-'));
  globalThis.__TOKEN_AUTH_HOME__ = home;
  saveCredentials('bluesky', { identifier: 'alice.bsky.social', password: 'app-pass', service: 'https://bsky.social' });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete globalThis.__TOKEN_AUTH_HOME__;
  delete globalThis.fetch;
});

describe('bluesky whoami', () => {
  it('validates the stored app-password session', async () => {
    mockFetch([['createSession', () => SESSION]]);
    const whoami = getRegistry().get('bluesky/whoami');
    await expect(whoami.func({})).resolves.toMatchObject({
      logged_in: true, site: 'bluesky', did: 'did:plc:alice', handle: 'alice.bsky.social',
    });
  });

  it('maps a rejected login to AuthRequiredError', async () => {
    mockFetch([['createSession', () => json(401, { error: 'AuthenticationRequired', message: 'bad password' })]]);
    const whoami = getRegistry().get('bluesky/whoami');
    await expect(whoami.func({})).rejects.toThrow(AuthRequiredError);
  });
});

describe('bluesky post', () => {
  it('publishes text-only and returns the post url', async () => {
    mockFetch([
      ['createSession', () => SESSION],
      ['createRecord', () => json(200, { uri: 'at://did:plc:alice/app.bsky.feed.post/abc123', cid: 'cid-xyz' })],
    ]);
    const post = getRegistry().get('bluesky/post');
    const [row] = await post.func({ text: 'hello world' });
    expect(row).toEqual({
      status: 'success',
      uri: 'at://did:plc:alice/app.bsky.feed.post/abc123',
      cid: 'cid-xyz',
      url: 'https://bsky.app/profile/alice.bsky.social/post/abc123',
    });
    // createRecord 收到了正确 record（无 embed）
    const rec = calls.find((c) => String(c.url).includes('createRecord'));
    const sent = JSON.parse(rec.init.body);
    expect(sent.collection).toBe('app.bsky.feed.post');
    expect(sent.record.text).toBe('hello world');
    expect(sent.record.embed).toBeUndefined();
  });

  it('uploads image blobs and embeds them', async () => {
    const imgPath = path.join(home, 'pic.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const blob = { $type: 'blob', ref: { $link: 'bafyblob' }, mimeType: 'image/png', size: 4 };
    mockFetch([
      ['createSession', () => SESSION],
      ['uploadBlob', () => json(200, { blob })],
      ['createRecord', () => json(200, { uri: 'at://did:plc:alice/app.bsky.feed.post/img1', cid: 'c2' })],
    ]);
    const post = getRegistry().get('bluesky/post');
    const [row] = await post.func({ text: 'with pic', images: imgPath, alt: 'a picture' });
    expect(row.status).toBe('success');

    const upload = calls.find((c) => String(c.url).includes('uploadBlob'));
    expect(upload.init.headers['Content-Type']).toBe('image/png');
    expect(upload.init.headers.Authorization).toBe('Bearer jwt-123');

    const rec = JSON.parse(calls.find((c) => String(c.url).includes('createRecord')).init.body);
    expect(rec.record.embed).toMatchObject({
      $type: 'app.bsky.embed.images',
      images: [{ alt: 'a picture', image: blob }],
    });
  });

  it('rejects too many images before any network call', async () => {
    mockFetch([['createSession', () => SESSION]]);
    const post = getRegistry().get('bluesky/post');
    await expect(post.func({ text: 'x', images: 'a.png,b.png,c.png,d.png,e.png' })).rejects.toThrow(/Too many images/);
  });
});
