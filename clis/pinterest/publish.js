/**
 * Pinterest pin — create a pin on a board, with title/description/destination link.
 *
 * Flow (py3-pinterest, MIT):
 *   1. resolve username + csrftoken
 *   2. GET BoardsResource → match --board by name (or create with --create-board)
 *   3. (optional best-effort) POST /upload-image/ for a local --image
 *   4. POST PinResource.create with {board_id, image_url, title, description, link}
 *
 * Usage:
 *   opencli pinterest pin "My pin" --image-url https://x/y.jpg --board "Inspiration" \
 *     --description "..." --link https://my-landing.example
 *   opencli pinterest pin "My pin" --image-url https://x/y.jpg --board "New" --create-board
 *
 * ⚠️ Real-machine verify (CI has no account): login → pin a test image to a test
 *   board → open https://www.pinterest.com/pin/<id>/ → confirm live, then delete.
 *   Pinterest also expects X-Pinterest-AppState/X-APP-VERSION headers the real web
 *   app sends; if create starts failing, capture them from a live Network tab.
 *   The /upload-image/ response field for the image url is uncertain — prefer
 *   --image-url until the local-upload path is verified on a real machine.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { buildBoardsOptions, buildCreateBoardOptions, buildPinOptions, selectBoardByName, csrfTokenFromCookies } from './api.js';
import { pinGet, pinCreate, resolvePinterestUser, pageFetch } from './client.js';

const EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

async function uploadLocalImage(page, localPath, csrf) {
  const abs = path.resolve(localPath);
  if (!EXT.has(path.extname(abs).toLowerCase())) throw new ArgumentError(`Unsupported image (jpg/png/gif/webp): ${localPath}`);
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) throw new ArgumentError(`Not a file: ${abs}`);
  const b64 = fs.readFileSync(abs).toString('base64');
  const name = path.basename(abs);
  const headers = { 'X-Requested-With': 'XMLHttpRequest', 'X-UPLOAD-SOURCE': 'pinner_uploader', ...(csrf ? { 'X-CSRFToken': csrf } : {}) };
  const result = await page.evaluate(`(async () => {
    try {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append('img', new Blob([arr]), ${JSON.stringify(name)});
      const res = await fetch('https://www.pinterest.com/upload-image/', { method: 'POST', credentials: 'include', headers: ${JSON.stringify(headers)}, body: fd });
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch {}
      return { ok: res.ok, status: res.status, data, text: text.slice(0, 300) };
    } catch (e) { return { ok: false, status: 0, data: null, text: String(e && e.message || e) }; }
  })()`);
  const r = result && typeof result === 'object' && 'session' in result && 'data' in result ? result.data : result;
  const url = r && r.data && (r.data.image_url || r.data.url || (r.data.success && r.data.success.image_url));
  if (!r || !r.ok || !url) {
    throw new CommandExecutionError(`Pinterest image upload failed (best-effort): HTTP ${r ? r.status : '?'} ${r ? r.text : ''}. Prefer --image-url.`);
  }
  return url;
}

cli({
  site: 'pinterest',
  name: 'pin',
  access: 'write',
  description: 'Create a pin on a board with an optional destination link',
  domain: 'www.pinterest.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'title', type: 'string', required: true, positional: true, help: 'Pin title' },
    { name: 'image-url', type: 'string', help: 'Image URL to pin (required unless --image)' },
    { name: 'image', type: 'string', help: '(best-effort) local image file to upload' },
    { name: 'board', type: 'string', required: true, help: 'Target board name' },
    { name: 'description', type: 'string', help: 'Pin description' },
    { name: 'link', type: 'string', help: 'Destination/landing URL (defaults to the image URL)' },
    { name: 'create-board', type: 'boolean', default: false, help: 'Create the board if it does not exist' },
  ],
  columns: ['status', 'pin_id', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for pinterest pin');
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new ArgumentError('pin title is required');
    const boardName = String(kwargs.board ?? '').trim();
    if (!boardName) throw new ArgumentError('--board is required');
    const imageUrl = kwargs['image-url'] ? String(kwargs['image-url']) : '';
    const localImage = kwargs.image ? String(kwargs.image) : '';
    if (!imageUrl && !localImage) throw new ArgumentError('provide --image-url (or --image local file)');

    const username = await resolvePinterestUser(page);
    const csrf = csrfTokenFromCookies(await page.getCookies({ url: 'https://www.pinterest.com' }));

    // resolve target board
    const boardsData = await pinGet(page, { resource: 'BoardsResource', sourceUrl: `/${username}/boards/`, options: buildBoardsOptions(username), label: 'boards' });
    const boards = Array.isArray(boardsData) ? boardsData : [];
    let board = selectBoardByName(boards, boardName);
    if (!board) {
      if (!kwargs['create-board']) {
        const names = boards.map((b) => b.name).join(', ') || '(none)';
        throw new ArgumentError(`Board "${boardName}" not found. Available: ${names} (use --create-board to create it)`);
      }
      board = await pinCreate(page, { resource: 'BoardResource', sourceUrl: `/${username}/boards/`, options: buildCreateBoardOptions(boardName, {}), csrf, label: 'board-create' });
    }

    const finalImageUrl = imageUrl || await uploadLocalImage(page, localImage, csrf);
    const options = buildPinOptions({ boardId: String(board.id), imageUrl: finalImageUrl, title, description: kwargs.description, link: kwargs.link });
    const data = await pinCreate(page, { resource: 'PinResource', sourceUrl: `/pin/find/?url=${encodeURIComponent(finalImageUrl)}`, options, csrf, label: 'pin' });
    const pinId = String(data.id ?? '');
    return { status: 'published', pin_id: pinId, url: pinId ? `https://www.pinterest.com/pin/${pinId}/` : '' };
  },
});

export const __test__ = { uploadLocalImage };
export { pageFetch };
