import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { botCall, telegramCreds } from './auth.js';

const MAX_MEDIA = 10; // sendMediaGroup 上限
const IMAGE = { '.jpg': 1, '.jpeg': 1, '.png': 1, '.webp': 1 };
const VIDEO = { '.mp4': 1, '.mov': 1, '.webm': 1 };

function classify(abs) {
  const ext = path.extname(abs).toLowerCase();
  if (IMAGE[ext]) return 'photo';
  if (VIDEO[ext]) return 'video';
  throw new ArgumentError(`Unsupported media format "${ext}". Supported: jpg, png, webp, mp4, mov, webm`);
}

function resolveMediaPaths(raw) {
  const paths = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (paths.length > MAX_MEDIA) throw new ArgumentError(`Too many media: ${paths.length} (max ${MAX_MEDIA})`);
  return paths.map((p) => {
    const abs = path.resolve(p);
    const type = classify(abs);
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new ArgumentError(`Not a valid file: ${abs}`);
    return { abs, type };
  });
}

function blobOf(abs) {
  return new Blob([fs.readFileSync(abs)], { type: 'application/octet-stream' });
}

function permalink(chat, messageId) {
  const m = String(chat).match(/^@?([A-Za-z]\w{3,})$/); // 公开频道用户名才有 t.me 永久链接
  return m ? `https://t.me/${m[1]}/${messageId}` : '';
}

function firstMessage(result) {
  return Array.isArray(result) ? result[0] : result;
}

cli({
  site: 'telegram',
  name: 'post',
  access: 'write',
  description: 'Send a message to the configured Telegram channel (text + optional media)',
  domain: 'telegram.org',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'text', type: 'string', required: true, positional: true, help: 'Message text / media caption' },
    { name: 'media', type: 'string', required: false, help: 'Media paths, comma-separated, max 10 (images/video)' },
  ],
  columns: ['status', 'message_id', 'url'],
  func: async (kwargs) => {
    const text = String(kwargs.text ?? '');
    const media = kwargs.media ? resolveMediaPaths(kwargs.media) : [];
    const { token, chat } = telegramCreds();

    let method;
    let init;
    if (media.length === 0) {
      method = 'sendMessage';
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) };
    } else if (media.length === 1) {
      const only = media[0];
      method = only.type === 'video' ? 'sendVideo' : 'sendPhoto';
      const form = new FormData();
      form.append('chat_id', String(chat));
      if (text) form.append('caption', text);
      form.append(only.type, blobOf(only.abs), path.basename(only.abs));
      init = { method: 'POST', body: form };
    } else {
      method = 'sendMediaGroup';
      const form = new FormData();
      form.append('chat_id', String(chat));
      const group = media.map((m, i) => ({
        type: m.type,
        media: `attach://file${i}`,
        ...(i === 0 && text ? { caption: text } : {}),
      }));
      form.append('media', JSON.stringify(group));
      media.forEach((m, i) => form.append(`file${i}`, blobOf(m.abs), path.basename(m.abs)));
      init = { method: 'POST', body: form };
    }

    const { res, body } = await botCall(token, method, init);
    if (!res.ok || !body?.ok) {
      throw new CommandExecutionError(`Telegram ${method} failed (HTTP ${res.status}): ${body?.description ?? 'unknown error'}`);
    }
    const msg = firstMessage(body.result);
    const messageId = msg?.message_id ?? '';
    return [{ status: 'success', message_id: String(messageId), url: permalink(chat, messageId) }];
  },
});
