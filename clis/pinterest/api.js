/**
 * Pinterest internal-API helpers — pure request builders (no browser, unit-tested).
 *
 * Ported from bstoilov/py3-pinterest (MIT). Pinterest's web app talks to
 * /resource/<Resource>/<get|create>/ with an x-www-form-urlencoded triple:
 *   source_url=<spa path>  data={"options":{...},"context":null}  _=<epoch-ms>
 * Spaces must encode as %20 (py3-pinterest replaces urlencode's '+' with %20).
 * Writes require the csrftoken cookie echoed into the X-CSRFToken header.
 */
import { CommandExecutionError } from '@jackwener/opencli/errors';

/** encodeURIComponent already encodes spaces as %20 (not '+'), matching py3-pinterest. */
export function pinUrlEncode(value) {
  return encodeURIComponent(String(value));
}

/** Build the source_url/data/_ form body string for a resource call. */
export function encodeResourceBody({ options, context = null, sourceUrl }, now = Date.now()) {
  const data = JSON.stringify({ options: options ?? {}, context });
  return `source_url=${pinUrlEncode(sourceUrl)}&data=${pinUrlEncode(data)}&_=${now}`;
}

export function csrfTokenFromCookies(cookies) {
  const hit = (cookies || []).find((c) => c && c.name === 'csrftoken');
  return hit ? hit.value : '';
}

export function writeHeaders(csrf) {
  return {
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    ...(csrf ? { 'X-CSRFToken': csrf } : {}),
  };
}

/** Pull resource_response.data, throwing a typed error on an error envelope. */
export function parseResourceData(json, label = 'resource') {
  const rr = json && json.resource_response;
  const data = rr && rr.data;
  if (data === undefined || data === null) {
    const err = rr && (rr.error || rr.message);
    throw new CommandExecutionError(`Pinterest ${label} returned no data${err ? ': ' + JSON.stringify(err) : ''}`);
  }
  return data;
}

export function buildBoardsOptions(username) {
  return {
    page_size: 50,
    privacy_filter: 'all',
    sort: 'custom',
    username,
    isPrefetch: false,
    include_archived: true,
    field_set_key: 'profile_grid_item',
    group_by: 'visibility',
  };
}

export function buildCreateBoardOptions(name, { description = '', privacy = 'public' } = {}) {
  return {
    name: String(name),
    description: String(description || ''),
    category: 'other',
    privacy: privacy === 'secret' || privacy === 'private' ? 'secret' : 'public',
    layout: 'default',
  };
}

export function selectBoardByName(boards, name) {
  const target = String(name ?? '').trim().toLowerCase();
  return (boards || []).find((b) => b && String(b.name ?? '').toLowerCase() === target) || null;
}

/** Options for PinResource.create. `link` (landing url) falls back to the image url. */
export function buildPinOptions({ boardId, imageUrl, title = '', description = '', link = '', altText = '' }) {
  return {
    board_id: String(boardId),
    image_url: imageUrl,
    title: String(title || ''),
    description: String(description || ''),
    link: link ? String(link) : imageUrl,
    alt_text: String(altText || ''),
    method: 'uploaded',
    scrape_metric: { source: 'www_url_scrape' },
    section: null,
  };
}
