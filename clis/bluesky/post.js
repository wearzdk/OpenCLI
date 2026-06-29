import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { authedSession } from './auth.js';

const MAX_IMAGES = 4; // AT Proto app.bsky.embed.images 上限
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

function resolveImagePaths(raw) {
  const paths = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (paths.length > MAX_IMAGES) {
    throw new ArgumentError(`Too many images: ${paths.length} (max ${MAX_IMAGES})`);
  }
  return paths.map((p) => {
    const abs = path.resolve(p);
    const ext = path.extname(abs).toLowerCase();
    if (!MIME[ext]) throw new ArgumentError(`Unsupported image format "${ext}". Supported: jpg, png, gif, webp`);
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new ArgumentError(`Not a valid file: ${abs}`);
    return { abs, mime: MIME[ext] };
  });
}

async function uploadBlob(session, { abs, mime }) {
  const res = await fetch(`${session.service}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: { 'Content-Type': mime, Authorization: `Bearer ${session.accessJwt}` },
    body: fs.readFileSync(abs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.blob) {
    throw new CommandExecutionError(`Bluesky uploadBlob failed for ${path.basename(abs)} (HTTP ${res.status}): ${body?.message ?? 'unknown error'}`);
  }
  return body.blob;
}

cli({
  site: 'bluesky',
  name: 'post',
  access: 'write',
  description: 'Publish a Bluesky post (text + optional images)',
  domain: 'bsky.app',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'text', type: 'string', required: true, positional: true, help: 'Post text (≤300 graphemes)' },
    { name: 'images', type: 'string', required: false, help: 'Image paths, comma-separated, max 4 (jpg/png/gif/webp)' },
    { name: 'alt', type: 'string', required: false, help: 'Alt text applied to all images (accessibility)' },
  ],
  columns: ['status', 'uri', 'cid', 'url'],
  func: async (kwargs) => {
    const text = String(kwargs.text ?? '');
    const images = kwargs.images ? resolveImagePaths(kwargs.images) : [];
    const session = await authedSession();

    let embed;
    if (images.length) {
      const blobs = [];
      for (const img of images) blobs.push(await uploadBlob(session, img));
      embed = {
        $type: 'app.bsky.embed.images',
        images: blobs.map((image) => ({ alt: String(kwargs.alt ?? ''), image })),
      };
    }

    const record = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      ...(embed ? { embed } : {}),
    };

    const res = await fetch(`${session.service}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessJwt}` },
      body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.uri) {
      throw new CommandExecutionError(`Bluesky createRecord failed (HTTP ${res.status}): ${body?.message ?? 'unknown error'}`);
    }

    const rkey = String(body.uri).split('/').pop();
    return [{
      status: 'success',
      uri: body.uri,
      cid: body.cid ?? '',
      url: `https://bsky.app/profile/${session.handle}/post/${rkey}`,
    }];
  },
});
