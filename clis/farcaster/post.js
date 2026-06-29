import { makeCastAdd, FarcasterNetwork, Message } from '@farcaster/core';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { farcasterCreds } from './auth.js';

const MAX_EMBEDS = 2; // Farcaster cast 最多 2 个 embed

cli({
  site: 'farcaster',
  name: 'post',
  access: 'write',
  description: 'Publish a Farcaster cast (text + optional image/embed URLs)',
  domain: 'farcaster.xyz',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'text', type: 'string', required: true, positional: true, help: 'Cast text (≤320 bytes)' },
    { name: 'embeds', type: 'string', required: false, help: 'Embed URLs (image/frame/link), comma-separated, max 2' },
    { name: 'channel', type: 'string', required: false, help: 'Channel parent URL (e.g. https://warpcast.com/~/channel/dev)' },
  ],
  columns: ['status', 'hash', 'url'],
  func: async (kwargs) => {
    const text = String(kwargs.text ?? '');
    const embedUrls = String(kwargs.embeds || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (embedUrls.length > MAX_EMBEDS) throw new ArgumentError(`Too many embeds: ${embedUrls.length} (max ${MAX_EMBEDS})`);
    const { fid, signer, hub } = farcasterCreds();

    const castBody = {
      text,
      embeds: embedUrls.map((url) => ({ url })),
      embedsDeprecated: [],
      mentions: [],
      mentionsPositions: [],
      ...(kwargs.channel ? { parentUrl: String(kwargs.channel) } : {}),
    };
    const built = await makeCastAdd(castBody, { fid, network: FarcasterNetwork.MAINNET }, signer);
    if (built.isErr()) throw new CommandExecutionError(`Failed to build cast: ${built.error?.message ?? 'unknown error'}`);
    const message = built.value;
    const bytes = Message.encode(message).finish();

    let res;
    try {
      res = await fetch(`${hub}/v1/submitMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
    } catch (err) {
      throw new CommandExecutionError(`Farcaster hub request failed: ${err?.message ?? err}`);
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      throw new AuthRequiredError('farcaster', `Hub rejected the message (HTTP ${res.status}) — is the signer registered for FID ${fid}? ${body?.details ?? ''}`);
    }
    if (!res.ok) {
      throw new CommandExecutionError(`Farcaster submitMessage failed (HTTP ${res.status}): ${body?.details ?? body?.errCode ?? 'unknown error'}`);
    }

    const hash = `0x${Buffer.from(message.hash).toString('hex')}`;
    return [{ status: 'success', hash, url: `https://warpcast.com/~/conversations/${hash}` }];
  },
});
