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
    calls.push({ url: String(url), init });
    for (const [frag, handler] of routes) {
      if (String(url).includes(frag) && (!handler.method || handler.method === (init?.method ?? 'GET'))) {
        return handler(String(url), init);
      }
    }
    throw new Error(`unexpected fetch: ${init?.method} ${url}`);
  });
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-'));
  globalThis.__TOKEN_AUTH_HOME__ = home;
  saveCredentials('threads', { token: 'tok-x', user_id: '999' });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete globalThis.__TOKEN_AUTH_HOME__;
  delete globalThis.fetch;
});

describe('threads whoami', () => {
  it('validates the stored token against the user id', async () => {
    mockFetch([['/999?', () => json(200, { id: '999', username: 'alice' })]]);
    const whoami = getRegistry().get('threads/whoami');
    await expect(whoami.func({})).resolves.toMatchObject({ logged_in: true, site: 'threads', id: '999', username: 'alice' });
    expect(calls[0].url).toContain('access_token=tok-x');
  });

  it('maps an OAuthException to AuthRequiredError', async () => {
    mockFetch([['/999?', () => json(400, { error: { type: 'OAuthException', message: 'bad token' } })]]);
    const whoami = getRegistry().get('threads/whoami');
    await expect(whoami.func({})).rejects.toThrow(AuthRequiredError);
  });
});

describe('threads post', () => {
  it('publishes a TEXT post in two steps and fetches the permalink', async () => {
    const create = () => json(200, { id: 'cont-1' });
    create.method = 'POST';
    const publishStep = () => json(200, { id: 'media-1' });
    publishStep.method = 'POST';
    const permalink = () => json(200, { permalink: 'https://www.threads.net/@alice/post/abc' });
    mockFetch([
      ['/threads_publish', publishStep],
      ['/999/threads', create],
      ['/media-1?', permalink],
    ]);
    const post = getRegistry().get('threads/post');
    const [row] = await post.func({ text: 'hello threads' });
    expect(row).toMatchObject({ status: 'success', id: 'media-1', creation_id: 'cont-1', permalink: 'https://www.threads.net/@alice/post/abc' });
    const containerCall = calls.find((c) => c.url.includes('/999/threads') && !c.url.includes('publish'));
    expect(containerCall.url).toContain('media_type=TEXT');
    // URLSearchParams encodes spaces as '+'
    expect(containerCall.url).toContain('text=hello+threads');
    const publishCall = calls.find((c) => c.url.includes('threads_publish'));
    expect(publishCall.url).toContain('creation_id=cont-1');
  });

  it('builds a carousel: child containers then a CAROUSEL container', async () => {
    let containerCount = 0;
    const create = (url) => {
      containerCount += 1;
      return json(200, { id: url.includes('CAROUSEL') ? 'carousel-1' : `child-${containerCount}` });
    };
    create.method = 'POST';
    const publishStep = () => json(200, { id: 'media-9' });
    publishStep.method = 'POST';
    mockFetch([
      ['/threads_publish', publishStep],
      ['/999/threads', create],
      ['/media-9?', () => json(200, { permalink: 'p' })],
    ]);
    const post = getRegistry().get('threads/post');
    const [row] = await post.func({ images: 'https://a.png, https://b.png', text: 'gallery' });
    expect(row.id).toBe('media-9');
    const childCalls = calls.filter((c) => c.url.includes('is_carousel_item=true'));
    expect(childCalls).toHaveLength(2);
    const carouselCall = calls.find((c) => c.url.includes('media_type=CAROUSEL'));
    expect(decodeURIComponent(carouselCall.url)).toContain('children=child-1,child-2');
  });

  it('rejects an empty post and a too-small carousel before publishing', async () => {
    mockFetch([['/999?', () => json(200, { id: '999', username: 'alice' })]]);
    const post = getRegistry().get('threads/post');
    await expect(post.func({})).rejects.toThrow(/Provide --text/);
    await expect(post.func({ images: 'https://only-one.png' })).rejects.toThrow(/2-20 images/);
  });
});
