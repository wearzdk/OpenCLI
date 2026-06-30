/**
 * Substack auth — login + whoami over the browser session cookie.
 *
 * Cookie login (Strategy.COOKIE): the user signs in at substack.com in Chrome;
 * `substack.sid` rides every request via credentials:'include'. Identity comes
 * from GET /api/v1/user/profile/self (python-substack), which also tells us the
 * primary publication we publish to.
 *
 * Real-machine verify: `opencli substack login` → `opencli substack whoami`
 * should show your publication; then `opencli substack publish ...`.
 */
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { publicationContext } from './post-utils.js';

async function hasSubstackSession(page) {
  const cookies = await page.getCookies({ url: 'https://substack.com' });
  return cookies.some((c) => c.name === 'substack.sid' || c.name === 'connect.sid');
}

async function verifySubstackIdentity(page) {
  if (!await hasSubstackSession(page)) {
    throw new AuthRequiredError('substack.com', 'Substack session cookie missing');
  }
  await page.goto('https://substack.com/');
  const result = await page.evaluate(`(async () => {
    try {
      const res = await fetch('/api/v1/user/profile/self', { credentials: 'include', headers: { 'Accept': 'application/json' } });
      if (res.status === 401 || res.status === 403) return { kind: 'auth', detail: 'profile/self HTTP ' + res.status };
      if (!res.ok) return { kind: 'http', httpStatus: res.status };
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch {}
      if (!data || data.id == null) return { kind: 'auth', detail: 'profile/self returned no user — anonymous' };
      return { ok: true, profile: data };
    } catch (e) { return { kind: 'exception', detail: String(e && e.message || e) }; }
  })()`);
  if (result?.kind === 'auth') throw new AuthRequiredError('substack.com', result.detail);
  if (result?.kind === 'http') throw new CommandExecutionError(`HTTP ${result.httpStatus} from profile/self`);
  if (result?.kind === 'exception') throw new CommandExecutionError(`Substack whoami failed: ${result.detail}`);
  if (!result?.ok) throw new CommandExecutionError(`Unexpected Substack probe: ${JSON.stringify(result)}`);
  const ctx = publicationContext(result.profile);
  return { user_id: String(ctx.userId), publication: ctx.publication, url: ctx.host };
}

registerSiteAuthCommands({
  site: 'substack',
  domain: 'substack.com',
  loginUrl: 'https://substack.com/sign-in',
  columns: ['user_id', 'publication', 'url'],
  quickCheck: hasSubstackSession,
  verify: verifySubstackIdentity,
  poll: async (page) => {
    if (!await hasSubstackSession(page)) {
      throw new AuthRequiredError('substack.com', 'Waiting for Substack session cookie');
    }
    return verifySubstackIdentity(page);
  },
});
