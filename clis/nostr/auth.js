import { getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { registerTokenAuth, requireCredentials } from '../_shared/token-auth.js';

// Nostr 发布：私钥（nsec，bech32）+ relay 列表。开放协议，事件本地签名后推给各 relay。
// 没有「登录态」概念——有合法 nsec 即「已配置」，identity = 从私钥派生的 npub。
//
// ⚠️ 安全：nsec 是账号的全部权力，明文落在 ~/.opencli/sites/nostr/credentials.json
// （0600）。经中转的 local_bash 能读到——中转鉴权是唯一闸门，whoami/login 只回 npub，
// 绝不回显 nsec。

/** 解析 relay 列表（逗号分隔），校验 ws/wss。 */
export function parseRelays(raw) {
  const relays = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const url of relays) {
    if (!/^wss?:\/\//.test(url)) throw new AuthRequiredError('nostr', `Invalid relay URL "${url}" (must start with wss:// or ws://)`);
  }
  return relays;
}

/** nsec → {sk, pubkey, npub}。非法 nsec 抛 AuthRequiredError。 */
export function decodeSecret(nsec) {
  let decoded;
  try {
    decoded = nip19.decode(String(nsec).trim());
  } catch {
    throw new AuthRequiredError('nostr', 'Invalid nsec (could not decode bech32 secret key)');
  }
  if (decoded.type !== 'nsec') throw new AuthRequiredError('nostr', `Expected an nsec, got "${decoded.type}"`);
  const sk = decoded.data;
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: nip19.npubEncode(pubkey) };
}

/** 已配置凭证 {sk, pubkey, npub, relays[]}（发布命令用）。 */
export function nostrIdentity() {
  const creds = requireCredentials('nostr');
  return { ...decodeSecret(creds.nsec), relays: parseRelays(creds.relays) };
}

registerTokenAuth({
  site: 'nostr',
  domain: 'nostr.com',
  fields: [
    { name: 'nsec', required: true, help: 'Secret key in nsec bech32 form (NOT your hex key in plaintext logs)' },
    { name: 'relays', required: true, help: 'Relay URLs, comma-separated, e.g. wss://relay.damus.io,wss://nos.lol' },
  ],
  identityColumns: ['npub', 'pubkey', 'relays'],
  loginDescription: 'Configure a Nostr nsec + relay list (no browser). Validates the key locally.',
  validate: async (creds) => {
    const { pubkey, npub } = decodeSecret(creds.nsec);
    const relays = parseRelays(creds.relays);
    if (relays.length === 0) throw new AuthRequiredError('nostr', 'At least one relay is required');
    return { npub, pubkey, relays: relays.join(', ') };
  },
});
