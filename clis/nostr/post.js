import { finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { nostrIdentity, parseRelays } from './auth.js';

const PUBLISH_TIMEOUT_MS = 8000;

// 把一个已签名事件推给一组 relay，逐个收集结果（不让单个 relay 失败拖垮整体）。
async function publishToRelays(relayUrls, event) {
  const results = await Promise.all(relayUrls.map(async (url) => {
    let relay;
    try {
      relay = await withTimeout(Relay.connect(url), `connect ${url}`);
      await withTimeout(relay.publish(event), `publish ${url}`);
      return { relay: url, ok: true };
    } catch (err) {
      return { relay: url, ok: false, error: err?.message ?? String(err) };
    } finally {
      try { relay?.close(); } catch { /* ignore */ }
    }
  }));
  return results;
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${PUBLISH_TIMEOUT_MS / 1000}s`)), PUBLISH_TIMEOUT_MS)),
  ]);
}

cli({
  site: 'nostr',
  name: 'post',
  access: 'write',
  description: 'Publish a Nostr note (kind 1) to your relays (text + optional image URLs)',
  domain: 'nostr.com',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'text', type: 'string', required: true, positional: true, help: 'Note content' },
    { name: 'image-url', type: 'string', required: false, help: 'External image URL(s), comma-separated (appended; clients embed them)' },
    { name: 'relays', type: 'string', required: false, help: 'Override configured relays for this post (comma-separated wss://)' },
  ],
  columns: ['status', 'id', 'note', 'relays_ok', 'relays_total'],
  func: async (kwargs) => {
    const { sk, relays: configured } = nostrIdentity();
    const relays = kwargs.relays ? parseRelays(kwargs.relays) : configured;
    if (relays.length === 0) throw new CommandExecutionError('No relays configured for nostr');

    // 外链图片：Nostr kind-1 无原生附件，URL 直接进正文由客户端渲染；同时补 NIP-92 imeta 标签。
    const imageUrls = String(kwargs['image-url'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const content = [String(kwargs.text ?? ''), ...imageUrls].filter(Boolean).join('\n');
    const tags = imageUrls.map((url) => ['imeta', `url ${url}`]);

    const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content }, sk);
    const results = await publishToRelays(relays, event);
    const okCount = results.filter((r) => r.ok).length;
    if (okCount === 0) {
      const why = results.map((r) => `${r.relay}: ${r.error}`).join('; ');
      throw new CommandExecutionError(`Nostr publish failed on all ${results.length} relays: ${why}`);
    }
    return [{
      status: okCount === results.length ? 'success' : 'partial',
      id: event.id,
      note: nip19.noteEncode(event.id),
      relays_ok: okCount,
      relays_total: results.length,
    }];
  },
});
