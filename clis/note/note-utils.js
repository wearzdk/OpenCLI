/**
 * note.com publish — pure payload/header builders (no browser, unit-tested).
 *
 * Endpoint facts from shimayuz/note-com-mcp (MIT) + Mr-SuperInsane/NoteClient2
 * (NON-OSI: facts/endpoints only, this is an original re-implementation, not a
 * code copy). note's internal API lives under https://note.com/api. Writes need
 * the XSRF-TOKEN cookie decoded into the X-XSRF-TOKEN header.
 */
import { ArgumentError } from '@jackwener/opencli/errors';

/** XSRF-TOKEN cookie → decoded X-XSRF-TOKEN header value. */
export function xsrfTokenFromCookies(cookies) {
  const hit = (cookies || []).find((c) => c && c.name === 'XSRF-TOKEN');
  if (!hit) return '';
  try { return decodeURIComponent(hit.value); } catch { return hit.value; }
}

export function noteWriteHeaders(xsrf) {
  return { 'Content-Type': 'application/json', ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {}) };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function textToParagraphs(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  return t.split(/\n{2,}/).map((c) => c.trim()).filter(Boolean);
}

/** Body is an HTML string: <p> per paragraph, <figure><img> per image url. */
export function buildBodyHtml(paragraphs, imageUrls = []) {
  const parts = (paragraphs || []).map((p) => `<p>${escapeHtml(p)}</p>`);
  for (const url of (imageUrls || [])) parts.push(`<figure><img src="${escapeHtml(url)}"></figure>`);
  return parts.join('');
}

export function bodyLength(html) {
  return String(html ?? '').length;
}

/** Hashtags: comma-separated → ['#tag', ...] (note prefixes with #). */
export function parseHashtags(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t}`));
}

/** Magazine ids: comma-separated numeric → number[]. */
export function parseMagazineIds(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new ArgumentError(`Invalid magazine id "${s}" (expected a number)`);
    return n;
  });
}

/** Body for POST /api/v1/text_notes/draft_save?id=<id>&is_temp_saved=true */
export function buildDraftSavePayload({ title, bodyHtml, imageKeys = [] }) {
  return {
    name: String(title ?? ''),
    body: String(bodyHtml ?? ''),
    body_length: bodyLength(bodyHtml),
    index: false,
    is_lead_form: false,
    image_keys: imageKeys,
  };
}

/** Body for PUT /api/v1/text_notes/<id> (publish). Free note: price 0, all in free_body. */
export function buildPublishPayload({ title, bodyHtml, hashtags = [], magazineIds = [], imageKeys = [] }) {
  return {
    name: String(title ?? ''),
    free_body: String(bodyHtml ?? ''),
    pay_body: '',
    status: 'published',
    price: 0,
    separator: null,
    is_refund: false,
    limited: false,
    index: false,
    image_keys: imageKeys,
    hashtags,
    magazine_ids: magazineIds,
    body_length: bodyLength(bodyHtml),
    send_notifications_flag: true,
    lead_form: null,
    line_add_friend: null,
  };
}

export function publicUrl(urlname, key) {
  return `https://note.com/${urlname}/n/${key}`;
}

/** Classify --images entries into url vs local path (no fs). */
export function classifyImages(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((value) => ({
    kind: /^https?:\/\//i.test(value) ? 'url' : 'path', value,
  }));
}
