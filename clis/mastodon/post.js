import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { mastodonCreds, mastoFetch } from './auth.js';

const MAX_MEDIA = 4;
const MEDIA_POLL_MS = 1000;
const MEDIA_POLL_MAX = 30; // 处理大图/视频时实例异步转码，最多等 ~30s
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};
const VISIBILITIES = ['public', 'unlisted', 'private', 'direct'];

function resolveMediaPaths(raw) {
  const paths = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (paths.length > MAX_MEDIA) throw new ArgumentError(`Too many media: ${paths.length} (max ${MAX_MEDIA})`);
  return paths.map((p) => {
    const abs = path.resolve(p);
    const ext = path.extname(abs).toLowerCase();
    if (!MIME[ext]) throw new ArgumentError(`Unsupported media format "${ext}". Supported: jpg, png, gif, webp, mp4, mov, webm`);
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new ArgumentError(`Not a valid file: ${abs}`);
    return { abs, mime: MIME[ext] };
  });
}

async function uploadMedia(ctx, { abs, mime }, description) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(abs)], { type: mime }), path.basename(abs));
  if (description) form.append('description', description);
  const res = await mastoFetch(ctx, '/api/v2/media', { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if ((res.status !== 200 && res.status !== 202) || !body?.id) {
    throw new CommandExecutionError(`Mastodon media upload failed for ${path.basename(abs)} (HTTP ${res.status}): ${body?.error ?? 'unknown error'}`);
  }
  // 202 = 实例仍在异步处理；轮询直到就绪（GET 返回 200）再用于发帖。
  if (res.status === 202) {
    for (let i = 0; i < MEDIA_POLL_MAX; i++) {
      await new Promise((r) => setTimeout(r, MEDIA_POLL_MS));
      const poll = await mastoFetch(ctx, `/api/v1/media/${body.id}`);
      if (poll.status === 200) return body.id;
    }
    throw new CommandExecutionError(`Mastodon media ${body.id} still processing after ${MEDIA_POLL_MAX}s`);
  }
  return body.id;
}

cli({
  site: 'mastodon',
  name: 'post',
  access: 'write',
  description: 'Publish a Mastodon status (text + optional media)',
  domain: 'joinmastodon.org',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'text', type: 'string', required: true, positional: true, help: 'Status text' },
    { name: 'media', type: 'string', required: false, help: 'Media paths, comma-separated, max 4 (images/video)' },
    { name: 'alt', type: 'string', required: false, help: 'Alt text / description applied to all media' },
    { name: 'visibility', type: 'string', required: false, default: 'public', choices: VISIBILITIES, help: 'public | unlisted | private | direct' },
    { name: 'sensitive', type: 'boolean', required: false, help: 'Mark media as sensitive' },
    { name: 'spoiler', type: 'string', required: false, help: 'Content warning / spoiler text' },
  ],
  columns: ['status', 'id', 'url'],
  func: async (kwargs) => {
    const text = String(kwargs.text ?? '');
    const visibility = String(kwargs.visibility ?? 'public');
    if (!VISIBILITIES.includes(visibility)) throw new ArgumentError(`Invalid --visibility "${visibility}". One of: ${VISIBILITIES.join(', ')}`);
    const media = kwargs.media ? resolveMediaPaths(kwargs.media) : [];
    const ctx = mastodonCreds();

    const mediaIds = [];
    for (const m of media) mediaIds.push(await uploadMedia(ctx, m, kwargs.alt ? String(kwargs.alt) : ''));

    const payload = {
      status: text,
      visibility,
      ...(mediaIds.length ? { media_ids: mediaIds } : {}),
      ...(kwargs.sensitive ? { sensitive: true } : {}),
      ...(kwargs.spoiler ? { spoiler_text: String(kwargs.spoiler) } : {}),
    };
    const res = await mastoFetch(ctx, '/api/v1/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `pp-${Date.now()}-${Math.random().toString(36).slice(2)}` },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.id) {
      throw new CommandExecutionError(`Mastodon post failed (HTTP ${res.status}): ${body?.error ?? 'unknown error'}`);
    }
    return [{ status: 'success', id: body.id, url: body.url ?? body.uri ?? '' }];
  },
});
