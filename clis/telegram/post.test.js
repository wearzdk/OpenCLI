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

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
  globalThis.__TOKEN_AUTH_HOME__ = home;
  saveCredentials('telegram', { token: '123:ABC', chat: '@mychannel' });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete globalThis.__TOKEN_AUTH_HOME__;
  delete globalThis.fetch;
});

describe('telegram whoami', () => {
  it('validates the bot token via getMe', async () => {
    mockFetch([['getMe', () => json(200, { ok: true, result: { id: 777, username: 'mybot', first_name: 'MyBot' } })]]);
    await expect(getRegistry().get('telegram/whoami').func({})).resolves.toMatchObject({
      logged_in: true, id: '777', username: 'mybot', name: 'MyBot', chat: '@mychannel',
    });
  });
  it('maps an invalid token to AuthRequiredError', async () => {
    mockFetch([['getMe', () => json(401, { ok: false, description: 'Unauthorized' })]]);
    await expect(getRegistry().get('telegram/whoami').func({})).rejects.toThrow(AuthRequiredError);
  });
});

describe('telegram post', () => {
  it('sends text via sendMessage and builds a t.me permalink', async () => {
    mockFetch([['sendMessage', () => json(200, { ok: true, result: { message_id: 55 } })]]);
    const [row] = await getRegistry().get('telegram/post').func({ text: 'hello channel' });
    expect(row).toEqual({ status: 'success', message_id: '55', url: 'https://t.me/mychannel/55' });
    const body = JSON.parse(calls.find((c) => c.url.includes('sendMessage')).init.body);
    expect(body).toEqual({ chat_id: '@mychannel', text: 'hello channel' });
  });

  it('sends a single photo via sendPhoto with caption', async () => {
    const img = path.join(home, 'a.jpg'); fs.writeFileSync(img, Buffer.from([1, 2]));
    mockFetch([['sendPhoto', () => json(200, { ok: true, result: { message_id: 56 } })]]);
    const [row] = await getRegistry().get('telegram/post').func({ text: 'cap', media: img });
    expect(row.message_id).toBe('56');
    const form = calls.find((c) => c.url.includes('sendPhoto')).init.body;
    expect(form.get('chat_id')).toBe('@mychannel');
    expect(form.get('caption')).toBe('cap');
    expect(form.get('photo')).toBeInstanceOf(Blob);
  });

  it('sends multiple media via sendMediaGroup with caption on the first', async () => {
    const a = path.join(home, 'a.jpg'); const b = path.join(home, 'b.mp4');
    fs.writeFileSync(a, Buffer.from([1])); fs.writeFileSync(b, Buffer.from([2]));
    mockFetch([['sendMediaGroup', () => json(200, { ok: true, result: [{ message_id: 60 }, { message_id: 61 }] })]]);
    const [row] = await getRegistry().get('telegram/post').func({ text: 'album', media: `${a},${b}` });
    expect(row.message_id).toBe('60');
    const form = calls.find((c) => c.url.includes('sendMediaGroup')).init.body;
    const group = JSON.parse(form.get('media'));
    expect(group).toEqual([
      { type: 'photo', media: 'attach://file0', caption: 'album' },
      { type: 'video', media: 'attach://file1' },
    ]);
    expect(form.get('file0')).toBeInstanceOf(Blob);
    expect(form.get('file1')).toBeInstanceOf(Blob);
  });
});
