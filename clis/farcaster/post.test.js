import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Message, validations } from '@farcaster/core';
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
const signerHex = Buffer.from(randomBytes(32)).toString('hex');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  globalThis.__TOKEN_AUTH_HOME__ = home;
  saveCredentials('farcaster', { fid: '12345', signer: signerHex, hub: 'https://hub.example' });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete globalThis.__TOKEN_AUTH_HOME__;
  delete globalThis.fetch;
});

describe('farcaster whoami', () => {
  it('derives signer pubkey from the configured key', async () => {
    const row = await getRegistry().get('farcaster/whoami').func({});
    expect(row.logged_in).toBe(true);
    expect(row.fid).toBe('12345');
    expect(row.signer_pubkey).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('rejects an invalid signer key', async () => {
    saveCredentials('farcaster', { fid: '1', signer: 'nothex', hub: 'https://hub.example' });
    await expect(getRegistry().get('farcaster/whoami').func({})).rejects.toThrow(AuthRequiredError);
  });
});

describe('farcaster post', () => {
  it('builds a valid signed cast and submits the encoded message to the hub', async () => {
    mockFetch([['/v1/submitMessage', () => json(200, { hash: '0xabc' })]]);
    const [row] = await getRegistry().get('farcaster/post').func({ text: 'gm farcaster', embeds: 'https://img.example/a.png' });
    expect(row.status).toBe('success');
    expect(row.hash).toMatch(/^0x[0-9a-f]+$/);
    expect(row.url).toContain('warpcast.com');

    const call = calls.find((c) => c.url.includes('/v1/submitMessage'));
    expect(call.init.headers['Content-Type']).toBe('application/octet-stream');
    // 解码提交的字节，做真实消息校验
    const msg = Message.decode(new Uint8Array(call.init.body));
    expect(msg.data.fid).toBe(12345);
    expect(msg.data.castAddBody.text).toBe('gm farcaster');
    expect(msg.data.castAddBody.embeds).toEqual([{ url: 'https://img.example/a.png' }]);
    const v = await validations.validateMessage(msg);
    expect(v.isOk()).toBe(true);
  });

  it('rejects too many embeds', async () => {
    mockFetch([]);
    await expect(getRegistry().get('farcaster/post').func({ text: 'x', embeds: 'a,b,c' })).rejects.toThrow(/Too many embeds/);
  });

  it('maps a 401 from the hub to AuthRequiredError (signer not registered)', async () => {
    mockFetch([['/v1/submitMessage', () => json(401, { details: 'unauthorized' })]]);
    await expect(getRegistry().get('farcaster/post').func({ text: 'x' })).rejects.toThrow(AuthRequiredError);
  });
});
