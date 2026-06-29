import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateSecretKey, verifyEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import { saveCredentials } from '../_shared/token-auth.js';

vi.mock('node:os', async (orig) => {
  const actual = await orig();
  return { ...actual, homedir: () => globalThis.__TOKEN_AUTH_HOME__ };
});

// 捕获被推送的事件；按 url 决定该 relay publish 成功/失败。
const published = [];
let failUrls = new Set();
vi.mock('nostr-tools/relay', () => ({
  Relay: {
    connect: async (url) => ({
      publish: async (event) => {
        if (failUrls.has(url)) throw new Error('relay rejected');
        published.push({ url, event });
        return 'ok';
      },
      close: () => {},
    }),
  },
}));

await import('./auth.js');
await import('./post.js');

let home;
let nsec;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nostr-'));
  globalThis.__TOKEN_AUTH_HOME__ = home;
  published.length = 0;
  failUrls = new Set();
  nsec = nip19.nsecEncode(generateSecretKey());
  saveCredentials('nostr', { nsec, relays: 'wss://relay.damus.io,wss://nos.lol' });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete globalThis.__TOKEN_AUTH_HOME__;
});

describe('nostr whoami', () => {
  it('derives npub from the configured nsec', async () => {
    const row = await getRegistry().get('nostr/whoami').func({});
    expect(row.logged_in).toBe(true);
    expect(row.npub).toMatch(/^npub1/);
    expect(row.relays).toContain('wss://relay.damus.io');
  });
  it('rejects an invalid nsec', async () => {
    saveCredentials('nostr', { nsec: 'nsec1garbage', relays: 'wss://nos.lol' });
    await expect(getRegistry().get('nostr/whoami').func({})).rejects.toThrow(AuthRequiredError);
  });
});

describe('nostr post', () => {
  it('signs a verifiable kind-1 event and publishes to all relays', async () => {
    const [row] = await getRegistry().get('nostr/post').func({ text: 'hello nostr' });
    expect(row.status).toBe('success');
    expect(row.relays_ok).toBe(2);
    expect(row.note).toMatch(/^note1/);
    expect(published).toHaveLength(2);
    // 真实签名校验
    expect(verifyEvent(published[0].event)).toBe(true);
    expect(published[0].event.content).toBe('hello nostr');
    expect(published[0].event.kind).toBe(1);
  });

  it('appends image URLs to content and adds imeta tags', async () => {
    await getRegistry().get('nostr/post').func({ text: 'pic', 'image-url': 'https://img.example/a.png' });
    const ev = published[0].event;
    expect(ev.content).toBe('pic\nhttps://img.example/a.png');
    expect(ev.tags).toContainEqual(['imeta', 'url https://img.example/a.png']);
  });

  it('reports partial when some relays fail', async () => {
    failUrls = new Set(['wss://nos.lol']);
    const [row] = await getRegistry().get('nostr/post').func({ text: 'x' });
    expect(row.status).toBe('partial');
    expect(row.relays_ok).toBe(1);
    expect(row.relays_total).toBe(2);
  });

  it('throws when all relays fail', async () => {
    failUrls = new Set(['wss://relay.damus.io', 'wss://nos.lol']);
    await expect(getRegistry().get('nostr/post').func({ text: 'x' })).rejects.toThrow(/failed on all/);
  });
});
