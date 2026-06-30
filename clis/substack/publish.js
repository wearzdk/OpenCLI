/**
 * Substack publish — create a post via the internal draft→publish API.
 *
 * Flow (python-substack, MIT):
 *   1. GET /api/v1/user/profile/self        → publication host + byline user id
 *   2. POST /api/v1/image (per image)       → CDN url (local file → base64 data-uri)
 *   3. POST /api/v1/drafts                  → draft id  (draft_body = JSON string)
 *   4. GET  /api/v1/drafts/<id>/prepublish  → validation gate
 *   5. POST /api/v1/drafts/<id>/publish     → publish  ({send, share_automatically})
 *
 * Usage:
 *   opencli substack publish "My title" --body "para 1\n\npara 2" \
 *     --subtitle "..." --images /a.png,https://x/y.jpg --audience everyone --section "Tech"
 *   opencli substack publish "Draft only" --body "..." --draft
 *
 * ⚠️ Real-machine verify (CI has no account, so the live loop is deferred):
 *   login → publish a throwaway post (or --draft first) → open the returned url
 *   → confirm it's live, then delete. audience/section field names + the publish
 *   response url shape (slug) should be re-checked against a live publication.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  publicationContext, validateAudience, imageDataUri, textToParagraphs, paragraphNode,
  imageBlock, buildDraftBody, buildDraftPayload, collectSections, resolveSectionId, classifyImages,
} from './post-utils.js';

const EXT_MIME = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.gif': 'gif', '.webp': 'webp' };

function unwrap(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'session' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

/** Run an authenticated fetch inside the page and return {ok,status,data,text}. */
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

/** Resolve --images entries to absolute readable local files; urls pass through. */
function resolveImageEntries(raw) {
  return classifyImages(raw).map((entry) => {
    if (entry.kind === 'url') return entry;
    const abs = path.resolve(entry.value);
    const ext = path.extname(abs).toLowerCase();
    if (!EXT_MIME[ext]) throw new ArgumentError(`Unsupported image "${ext}" (jpg/png/gif/webp): ${entry.value}`);
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) throw new ArgumentError(`Not a file: ${abs}`);
    return { kind: 'path', value: abs, mime: EXT_MIME[ext] };
  });
}

cli({
  site: 'substack',
  name: 'publish',
  access: 'write',
  description: 'Publish a post to your Substack publication (or save a draft with --draft)',
  domain: 'substack.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'title', type: 'string', required: true, positional: true, help: 'Post title' },
    { name: 'body', type: 'string', help: 'Post body text (blank lines split paragraphs)' },
    { name: 'subtitle', type: 'string', help: 'Optional subtitle' },
    { name: 'images', type: 'string', help: 'Images: comma-separated local paths and/or http(s) urls' },
    { name: 'audience', type: 'string', default: 'everyone', help: 'Visibility: everyone | only_paid' },
    { name: 'section', type: 'string', help: 'Section name to file the post under' },
    { name: 'send', type: 'boolean', default: false, help: 'Also email subscribers on publish' },
    { name: 'draft', type: 'boolean', default: false, help: 'Create the draft but do not publish' },
  ],
  columns: ['status', 'publication', 'draft_id', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for substack publish');
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new ArgumentError('substack publish: title is required');
    const audience = validateAudience(kwargs.audience);
    const images = resolveImageEntries(kwargs.images);

    // 1. identity → publication host + byline
    await page.goto('https://substack.com/');
    const prof = await pageFetch(page, { url: 'https://substack.com/api/v1/user/profile/self' });
    if (prof.status === 401 || prof.status === 403 || !prof.data || prof.data.id == null) {
      throw new AuthRequiredError('substack.com', `Not logged in (profile/self HTTP ${prof.status})`);
    }
    const { host, userId, publication } = publicationContext(prof.data);
    await page.goto(`${host}/`);

    // 2. upload images → CDN urls
    const imageBlocks = [];
    for (const img of images) {
      let src = img.value;
      if (img.kind === 'path') {
        const b64 = fs.readFileSync(img.value).toString('base64');
        const up = await pageFetch(page, {
          url: `${host}/api/v1/image`,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `image=${encodeURIComponent(imageDataUri(b64, img.mime))}`,
        });
        if (!up.ok || !up.data?.url) throw new CommandExecutionError(`Substack image upload failed: HTTP ${up.status} ${up.text}`);
        src = up.data.url;
      }
      imageBlocks.push(imageBlock(src));
    }

    // 3. body doc → create draft
    const blocks = [...textToParagraphs(kwargs.body).map(paragraphNode), ...imageBlocks];
    if (!blocks.length) blocks.push(paragraphNode(''));
    const bodyDoc = buildDraftBody(blocks);

    let sectionId = null;
    if (kwargs.section) {
      const subs = await pageFetch(page, { url: `${host}/api/v1/subscriptions` });
      sectionId = resolveSectionId(collectSections(subs.data), kwargs.section);
    }

    const draftPayload = buildDraftPayload({ title, subtitle: kwargs.subtitle, bodyDoc, userId, audience, sectionId });
    const created = await pageFetch(page, {
      url: `${host}/api/v1/drafts`, method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draftPayload),
    });
    if (!created.ok || created.data?.id == null) {
      throw new CommandExecutionError(`Substack create-draft failed: HTTP ${created.status} ${created.text}`);
    }
    const draftId = created.data.id;
    const editUrl = `${host}/publish/post/${draftId}`;
    if (kwargs.draft) return { status: 'draft', publication, draft_id: String(draftId), url: editUrl };

    // 4. prepublish gate
    const pre = await pageFetch(page, { url: `${host}/api/v1/drafts/${draftId}/prepublish` });
    if (!pre.ok) throw new CommandExecutionError(`Substack prepublish failed: HTTP ${pre.status} ${pre.text}`);

    // 5. publish
    const pub = await pageFetch(page, {
      url: `${host}/api/v1/drafts/${draftId}/publish`, method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ send: !!kwargs.send, share_automatically: false }),
    });
    if (!pub.ok) throw new CommandExecutionError(`Substack publish failed: HTTP ${pub.status} ${pub.text}`);
    const slug = pub.data?.slug;
    return { status: 'published', publication, draft_id: String(draftId), url: slug ? `${host}/p/${slug}` : editUrl };
  },
});

export const __test__ = { resolveImageEntries, EXT_MIME };
