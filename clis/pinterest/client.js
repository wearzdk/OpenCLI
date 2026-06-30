/**
 * Pinterest browser-side client — runs authed fetches inside the logged-in page.
 * Thin orchestration over api.js builders; the pure logic lives in api.js.
 */
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { encodeResourceBody, writeHeaders, parseResourceData } from './api.js';

const BASE = 'https://www.pinterest.com';

export function unwrap(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'session' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

export async function pageFetch(page, { url, method = 'GET', headers = {}, body = null }) {
  const script = `(async () => {
    try {
      const opts = { method: ${JSON.stringify(method)}, credentials: 'include', headers: ${JSON.stringify(headers)} };
      ${body != null ? `opts.body = ${JSON.stringify(body)};` : ''}
      const res = await fetch(${JSON.stringify(url)}, opts);
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch {}
      return { ok: res.ok, status: res.status, data, text: text.slice(0, 300) };
    } catch (e) { return { ok: false, status: 0, data: null, text: String(e && e.message || e) }; }
  })()`;
  return unwrap(await page.evaluate(script));
}

export async function pinGet(page, { resource, sourceUrl, options, label }) {
  const body = encodeResourceBody({ options, sourceUrl });
  const res = await pageFetch(page, { url: `${BASE}/resource/${resource}/get/?${body}`, headers: { Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw new AuthRequiredError('www.pinterest.com', `${label || resource} HTTP ${res.status}`);
  if (!res.ok) throw new CommandExecutionError(`Pinterest ${label || resource} failed: HTTP ${res.status} ${res.text}`);
  return parseResourceData(res.data, label || resource);
}

export async function pinCreate(page, { resource, sourceUrl, options, csrf, label }) {
  const body = encodeResourceBody({ options, sourceUrl });
  const res = await pageFetch(page, { url: `${BASE}/resource/${resource}/create/`, method: 'POST', headers: { Accept: 'application/json', ...writeHeaders(csrf) }, body });
  if (res.status === 401 || res.status === 403) throw new AuthRequiredError('www.pinterest.com', `${label || resource} HTTP ${res.status}`);
  if (!res.ok) throw new CommandExecutionError(`Pinterest ${label || resource} failed: HTTP ${res.status} ${res.text}`);
  return parseResourceData(res.data, label || resource);
}

/**
 * Resolve the logged-in username from the SPA bootstrap globals.
 * ⚠️ Pinterest has no clean "me" endpoint; this reads __PWS_INITIAL_PROPS__ which
 * is the flagged-uncertain part — re-verify the exact path on a real machine.
 */
export async function resolvePinterestUser(page) {
  await page.goto(`${BASE}/`);
  const username = unwrap(await page.evaluate(`(() => {
    try {
      const p = window.__PWS_INITIAL_PROPS__ || window.__PWS_DATA__ || {};
      const rs = p.initialReduxState || p.reduxState || {};
      const sess = rs.session || {};
      const viewer = rs.viewer || (p.context && p.context.viewer) || sess;
      let u = (viewer && viewer.username) || null;
      if (!u && sess.userId && rs.users && rs.users[sess.userId]) u = rs.users[sess.userId].username;
      return u || null;
    } catch (e) { return null; }
  })()`));
  if (!username) throw new AuthRequiredError('www.pinterest.com', 'Could not resolve Pinterest username — not logged in?');
  return String(username);
}
