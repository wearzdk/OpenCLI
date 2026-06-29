import { NobleEd25519Signer } from '@farcaster/core';
import { AuthRequiredError, ArgumentError } from '@jackwener/opencli/errors';
import { registerTokenAuth, requireCredentials } from '../_shared/token-auth.js';

// Farcaster 发布：FID + signer（ed25519 私钥，已在链上为该 FID 授权的 app key）。
// cast 是本地 ed25519 签名的 protobuf 消息，提交给 hub 的 HTTP API。
// ⚠️ 最大摩擦在「signer 注册」：signer 必须先经 Warpcast / 链上为该 FID 授权，本适配器
// 假定 signer 已注册（注册流程不在胶水层范围内）。
// ⚠️ 安全：signer 私钥明文落 ~/.opencli/sites/farcaster/credentials.json（0600），
// 经中转可达——whoami 只回 fid + signer 公钥，绝不回显私钥。

export const DEFAULT_HUB = 'https://hub.pinata.cloud';

/** signer hex（带不带 0x 均可）→ 32 字节私钥。 */
export function decodeSignerKey(raw) {
  const hex = String(raw || '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new AuthRequiredError('farcaster', 'Invalid signer key (expected 32-byte ed25519 private key as 64 hex chars)');
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function parseFid(raw) {
  const fid = Number(raw);
  if (!Number.isInteger(fid) || fid <= 0) throw new ArgumentError(`Invalid --fid "${raw}" (must be a positive integer)`);
  return fid;
}

export function resolveHub(creds) {
  const raw = String(creds.hub || DEFAULT_HUB).trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

/** 已配置凭证 {fid, signer, hub}（发布命令用）。 */
export function farcasterCreds() {
  const creds = requireCredentials('farcaster');
  return { fid: parseFid(creds.fid), signer: new NobleEd25519Signer(decodeSignerKey(creds.signer)), hub: resolveHub(creds) };
}

registerTokenAuth({
  site: 'farcaster',
  domain: 'farcaster.xyz',
  fields: [
    { name: 'fid', required: true, help: 'Your Farcaster FID (number)' },
    { name: 'signer', required: true, help: 'ed25519 signer private key (64 hex chars) — must be registered for this FID' },
    { name: 'hub', required: false, default: DEFAULT_HUB, help: `Hub HTTP API base URL (default ${DEFAULT_HUB})` },
  ],
  identityColumns: ['fid', 'signer_pubkey', 'hub'],
  loginDescription: 'Configure a Farcaster FID + signer key (no browser). Validates the key locally.',
  validate: async (creds) => {
    const fid = parseFid(creds.fid);
    const signer = new NobleEd25519Signer(decodeSignerKey(creds.signer));
    const keyResult = await signer.getSignerKey();
    if (keyResult.isErr()) throw new AuthRequiredError('farcaster', `Could not derive signer public key: ${keyResult.error?.message ?? 'invalid key'}`);
    return { fid: String(fid), signer_pubkey: `0x${Buffer.from(keyResult.value).toString('hex')}`, hub: resolveHub(creds) };
  },
});
