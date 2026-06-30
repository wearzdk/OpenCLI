/**
 * note.com auth — login + whoami over the browser session cookie.
 *
 * Cookie login (Strategy.COOKIE): user signs in at note.com in Chrome;
 * `_note_session_v5` rides requests. Identity from GET /api/v2/current_user.
 *
 * Real-machine verify: `opencli note login` → `opencli note whoami` shows your
 * urlname/nickname → `opencli note publish ...`.
 */
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

async function hasNoteSession(page) {
  const cookies = await page.getCookies({ url: 'https://note.com' });
  return cookies.some((c) => c.name === '_note_session_v5');
}

async function verifyNoteIdentity(page) {
  if (!await hasNoteSession(page)) {
    throw new AuthRequiredError('note.com', 'note _note_session_v5 cookie missing');
  }
  await page.goto('https://note.com/');
  const result = await page.evaluate(`(async () => {
    try {
      const res = await fetch('/api/v2/current_user', { credentials: 'include', headers: { 'Accept': 'application/json' } });
      if (res.status === 401 || res.status === 403) return { kind: 'auth', detail: 'current_user HTTP ' + res.status };
      if (!res.ok) return { kind: 'http', httpStatus: res.status };
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      const d = json && (json.data || json);
      if (!d || (d.urlname == null && d.id == null)) return { kind: 'auth', detail: 'current_user returned no user — anonymous' };
      return { ok: true, urlname: String(d.urlname || ''), nickname: String(d.nickname || ''), user_id: String(d.id || '') };
    } catch (e) { return { kind: 'exception', detail: String(e && e.message || e) }; }
  })()`);
  if (result?.kind === 'auth') throw new AuthRequiredError('note.com', result.detail);
  if (result?.kind === 'http') throw new CommandExecutionError(`HTTP ${result.httpStatus} from current_user`);
  if (result?.kind === 'exception') throw new CommandExecutionError(`note whoami failed: ${result.detail}`);
  if (!result?.ok) throw new CommandExecutionError(`Unexpected note probe: ${JSON.stringify(result)}`);
  return { urlname: result.urlname, nickname: result.nickname, url: result.urlname ? `https://note.com/${result.urlname}` : '' };
}

registerSiteAuthCommands({
  site: 'note',
  domain: 'note.com',
  loginUrl: 'https://note.com/login',
  columns: ['urlname', 'nickname', 'url'],
  quickCheck: hasNoteSession,
  verify: verifyNoteIdentity,
  poll: async (page) => {
    if (!await hasNoteSession(page)) {
      throw new AuthRequiredError('note.com', 'Waiting for note session cookie');
    }
    return verifyNoteIdentity(page);
  },
});
