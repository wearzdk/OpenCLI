/**
 * Substack publish — pure payload/body builders (no browser, fully unit-tested).
 *
 * Ported from the internal API used by ma2za/python-substack (MIT). Field names
 * and the ProseMirror `draft_body` doc shape are quoted from that source; verify
 * against a live publication before trusting on a real machine.
 */
import { AuthRequiredError, ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

const VALID_AUDIENCES = new Set(['everyone', 'only_paid']);

/**
 * Resolve which publication to post to + the byline user id from
 * `GET /api/v1/user/profile/self`. Picks the primary publication.
 * Host rule (python-substack get_publication_url): use the custom domain only
 * when it exists and is not "optional"; otherwise the `<subdomain>.substack.com`.
 */
export function publicationContext(profile) {
  if (!profile || profile.id == null) {
    throw new AuthRequiredError('substack.com', 'Not logged in to Substack (profile has no id)');
  }
  const pubUsers = Array.isArray(profile.publicationUsers) ? profile.publicationUsers : [];
  const chosen = pubUsers.find((p) => p && p.is_primary) || pubUsers[0];
  const pub = chosen && chosen.publication;
  if (!pub || !pub.subdomain) {
    throw new CommandExecutionError('Substack account has no publication to publish to');
  }
  const host = pub.custom_domain && !pub.custom_domain_optional
    ? `https://${pub.custom_domain}`
    : `https://${pub.subdomain}.substack.com`;
  return { host, userId: profile.id, publication: pub.name || pub.subdomain, subdomain: pub.subdomain };
}

export function validateAudience(audience) {
  const a = String(audience ?? 'everyone');
  if (!VALID_AUDIENCES.has(a)) {
    throw new ArgumentError(`Invalid --audience "${a}" (allowed: everyone, only_paid)`);
  }
  return a;
}

/** base64 (no prefix) + mime ("jpeg"/"png"/...) → a data URI the /image endpoint accepts. */
export function imageDataUri(base64, mime) {
  return `data:image/${mime || 'jpeg'};base64,${base64}`;
}

/**
 * Split free-form text into paragraph blocks. Blank lines separate paragraphs;
 * a single newline inside a paragraph is kept as one text node (Substack renders
 * soft breaks fine). Returns [] for empty input.
 */
export function textToParagraphs(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  return t.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean);
}

export function paragraphNode(text) {
  const content = String(text ?? '').length ? [{ type: 'text', text: String(text) }] : [];
  return { type: 'paragraph', content };
}

/** Substack image node: captionedImage wrapping an inner image2 (per python-substack). */
export function imageBlock(src, { width = 1456, height = 819 } = {}) {
  return {
    type: 'captionedImage',
    content: [{
      type: 'image2',
      attrs: {
        src,
        fullscreen: false,
        imageSize: 'normal',
        height,
        width,
        resizeWidth: Math.round(width / 2),
        bytes: null,
        alt: null,
        title: null,
        type: null,
        href: null,
        belowTheFold: false,
        internalRedirect: null,
      },
    }],
  };
}

export function buildDraftBody(blocks) {
  return { type: 'doc', content: Array.isArray(blocks) ? blocks : [] };
}

/**
 * Body for `POST /api/v1/drafts`. CRITICAL: `draft_body` must be a JSON STRING,
 * not a nested object (python-substack json.dumps's the doc).
 */
export function buildDraftPayload({ title, subtitle = '', bodyDoc, userId, audience = 'everyone', sectionId = null }) {
  return {
    draft_title: String(title ?? ''),
    draft_subtitle: String(subtitle ?? ''),
    draft_body: JSON.stringify(bodyDoc ?? buildDraftBody([])),
    draft_bylines: [{ id: userId, is_guest: false }],
    audience,
    draft_section_id: sectionId,
    section_chosen: sectionId != null,
    write_comment_permissions: 'everyone',
  };
}

/** Flatten sections out of GET /api/v1/subscriptions (publications[].sections[]). */
export function collectSections(subscriptions) {
  const pubs = subscriptions && Array.isArray(subscriptions.publications) ? subscriptions.publications : [];
  const out = [];
  for (const pub of pubs) {
    for (const s of (Array.isArray(pub?.sections) ? pub.sections : [])) {
      if (s && s.id != null && s.name) out.push({ id: s.id, name: String(s.name) });
    }
  }
  return out;
}

export function resolveSectionId(sections, name) {
  const target = String(name ?? '').trim().toLowerCase();
  const hit = (sections || []).find((s) => String(s.name).toLowerCase() === target);
  if (!hit) {
    const available = (sections || []).map((s) => s.name).join(', ') || '(none)';
    throw new ArgumentError(`Substack section "${name}" not found. Available: ${available}`);
  }
  return hit.id;
}

/** Classify --images entries into {kind:'url'|'path', value} preserving order. No fs access. */
export function classifyImages(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((value) => ({
    kind: /^https?:\/\//i.test(value) ? 'url' : 'path',
    value,
  }));
}

export const __test__ = { VALID_AUDIENCES };
