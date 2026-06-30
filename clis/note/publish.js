/**
 * note.com publish — create a text note via the internal API and publish it.
 *
 * Flow (shimayuz/note-com-mcp MIT + NoteClient2 endpoint facts, re-implemented):
 *   1. GET  /api/v2/current_user                                  → urlname (auth)
 *   2. POST /api/v1/text_notes  {template_key:null}               → note id + key
 *   3. (best-effort) POST editor.note.com/api/v1/presigns         → in-body image urls
 *   4. POST /api/v1/text_notes/draft_save?id=<id>&is_temp_saved=true  → save body
 *   5. PUT  /api/v1/text_notes/<id>  {status:'published', ...}    → publish
 *
 * Usage:
 *   opencli note publish "タイトル" --body "本文\n\n段落2" --tags AI,opencli --magazine 12345
 *   opencli note publish "下書き" --body "..." --draft
 *
 * ⚠️ Real-machine verify (CI has no account): login → publish a throwaway note
 *   → open the returned url → confirm live, then delete. Highest-drift items to
 *   re-check on a real session: the publish `status` enum ('published' vs
 *   'public'), whether publish is PUT-with-status vs a /publish sub-route, the
 *   eyecatch/cover response field, and the in-body presign/upload response shape.
 *   Cover (--cover) and in-body image (--images) upload are best-effort here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  xsrfTokenFromCookies, noteWriteHeaders, textToParagraphs, buildBodyHtml,
  parseHashtags, parseMagazineIds, buildDraftSavePayload, buildPublishPayload,
  publicUrl, classifyImages,
} from './note-utils.js';

const EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function unwrap(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'session' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

async function pageFetch(page, { url, method = 'GET', headers = {}, body = null }) {
  const script = `(async () => {
    try {
      const opts = { method: ${JSON.stringify(method)}, credentials: 'include', headers: ${JSON.stringify({ Accept: 'application/json', ...headers })} };
      ${body != null ? `opts.body = ${JSON.stringify(body)};` : ''}
      const res = await fetch(${JSON.stringify(url)}, opts);
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch {}
      return { ok: res.ok, status: res.status, data, text: text.slice(0, 300) };
    } catch (e) { return { ok: false, status: 0, data: null, text: String(e && e.message || e) }; }
  })()`;
  return unwrap(await page.evaluate(script));
}

/** Best-effort in-body image: presign on editor.note.com, PUT bytes, return final url. */
async function uploadInlineImage(page, localPath, xsrf) {
  const abs = path.resolve(localPath);
  if (!EXT.has(path.extname(abs).toLowerCase())) throw new ArgumentError(`Unsupported image (jpg/png/gif/webp): ${localPath}`);
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) throw new ArgumentError(`Not a file: ${abs}`);
  const presign = await pageFetch(page, {
    url: 'https://editor.note.com/api/v1/presigns', method: 'POST',
    headers: noteWriteHeaders(xsrf), body: JSON.stringify({ filename: path.basename(abs) }),
  });
  const d = presign && presign.data && (presign.data.data || presign.data);
  const putUrl = d && d.url;
  const finalUrl = d && (d.s3_url || d.url);
  if (!presign.ok || !putUrl || !finalUrl) {
    throw new CommandExecutionError(`note image presign failed (best-effort): HTTP ${presign.status} ${presign.text}`);
  }
  const b64 = fs.readFileSync(abs).toString('base64');
  const put = await page.evaluate(`(async () => {
    try {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const res = await fetch(${JSON.stringify(putUrl)}, { method: 'PUT', body: new Blob([arr]) });
      return { ok: res.ok, status: res.status };
    } catch (e) { return { ok: false, status: 0, text: String(e && e.message || e) }; }
  })()`);
  const p = unwrap(put);
  if (!p || !p.ok) throw new CommandExecutionError(`note image upload PUT failed (best-effort): HTTP ${p ? p.status : '?'}`);
  return finalUrl;
}

cli({
  site: 'note',
  name: 'publish',
  access: 'write',
  description: 'Publish a text note to note.com (or save a draft with --draft)',
  domain: 'note.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'title', type: 'string', required: true, positional: true, help: 'Note title' },
    { name: 'body', type: 'string', help: 'Note body text (blank lines split paragraphs)' },
    { name: 'tags', type: 'string', help: 'Hashtags, comma-separated (# optional)' },
    { name: 'magazine', type: 'string', help: 'Magazine id(s) to file under, comma-separated' },
    { name: 'images', type: 'string', help: '(best-effort) in-body images: local paths and/or urls' },
    { name: 'draft', type: 'boolean', default: false, help: 'Save the draft but do not publish' },
  ],
  columns: ['status', 'note_key', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for note publish');
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new ArgumentError('note publish: title is required');
    const hashtags = parseHashtags(kwargs.tags);
    const magazineIds = parseMagazineIds(kwargs.magazine);
    const imageEntries = classifyImages(kwargs.images);

    await page.goto('https://note.com/');
    const xsrf = xsrfTokenFromCookies(await page.getCookies({ url: 'https://note.com' }));

    // 1. auth
    const me = await pageFetch(page, { url: 'https://note.com/api/v2/current_user' });
    const meData = me.data && (me.data.data || me.data);
    if (me.status === 401 || me.status === 403 || !meData || !meData.urlname) {
      throw new AuthRequiredError('note.com', `Not logged in (current_user HTTP ${me.status})`);
    }
    const urlname = String(meData.urlname);

    // 2. create draft
    const created = await pageFetch(page, {
      url: 'https://note.com/api/v1/text_notes', method: 'POST',
      headers: noteWriteHeaders(xsrf), body: JSON.stringify({ template_key: null }),
    });
    const cData = created.data && (created.data.data || created.data);
    if (!created.ok || !cData || cData.id == null) {
      throw new CommandExecutionError(`note create-draft failed: HTTP ${created.status} ${created.text}`);
    }
    const noteId = cData.id;
    let noteKey = cData.key ? String(cData.key) : '';

    // 3. in-body images (best-effort)
    const imageUrls = [];
    for (const img of imageEntries) {
      imageUrls.push(img.kind === 'url' ? img.value : await uploadInlineImage(page, img.value, xsrf));
    }

    // 4. save body
    const bodyHtml = buildBodyHtml(textToParagraphs(kwargs.body), imageUrls);
    const save = await pageFetch(page, {
      url: `https://note.com/api/v1/text_notes/draft_save?id=${encodeURIComponent(noteId)}&is_temp_saved=true`,
      method: 'POST', headers: noteWriteHeaders(xsrf), body: JSON.stringify(buildDraftSavePayload({ title, bodyHtml })),
    });
    if (!save.ok) throw new CommandExecutionError(`note draft_save failed: HTTP ${save.status} ${save.text}`);

    if (kwargs.draft) {
      return { status: 'draft', note_key: noteKey, url: noteKey ? publicUrl(urlname, noteKey) : `https://note.com/notes/${noteId}/edit` };
    }

    // 5. publish
    const pub = await pageFetch(page, {
      url: `https://note.com/api/v1/text_notes/${encodeURIComponent(noteId)}`, method: 'PUT',
      headers: noteWriteHeaders(xsrf), body: JSON.stringify(buildPublishPayload({ title, bodyHtml, hashtags, magazineIds })),
    });
    if (!pub.ok) throw new CommandExecutionError(`note publish failed: HTTP ${pub.status} ${pub.text}`);
    const pData = pub.data && (pub.data.data || pub.data);
    if (pData && pData.note_key) noteKey = String(pData.note_key);
    const url = (pData && pData.public_url) || (noteKey ? publicUrl(urlname, noteKey) : `https://note.com/${urlname}`);
    return { status: 'published', note_key: noteKey, url };
  },
});

export const __test__ = { uploadInlineImage };
