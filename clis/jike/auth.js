import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

// Jike web (web.okjike.com) is an SPA shell that stores a JWT in localStorage
// under JK_ACCESS_TOKEN and forwards it as the x-jike-access-token header to the
// api.ruguoapp.com gateway. The JWT payload is encrypted, so identity is read
// from the /1.0/users/profile endpoint rather than from the token or a cookie.
const WHOAMI_PROBE = `(async () => {
  try {
    const token = localStorage.getItem('JK_ACCESS_TOKEN') || '';
    if (!token) return { kind: 'auth', detail: 'Jike JK_ACCESS_TOKEN missing from localStorage (anonymous)' };
    const r = await fetch('https://api.ruguoapp.com/1.0/users/profile', {
      headers: { 'x-jike-access-token': token, Accept: 'application/json' },
    });
    if (r.status === 401 || r.status === 403) return { kind: 'auth', detail: 'Jike users/profile HTTP ' + r.status };
    if (!r.ok) return { kind: 'http', httpStatus: r.status };
    const d = await r.json();
    const u = d && d.user;
    if (!u || !u.id) return { kind: 'auth', detail: 'Jike users/profile returned no user (anonymous)' };
    return { ok: true, user_id: String(u.id), screen_name: String(u.screenName || ''), username: String(u.username || '') };
  } catch (e) {
    return { kind: 'exception', detail: String(e && e.message || e) };
  }
})()`;

async function verifyJikeIdentity(page) {
  await page.goto('https://web.okjike.com/');
  await page.wait(2);
  // Navigation race: page.goto can resolve while the tab is still on the blank
  // 'data:' bootstrap URL (SPA shell not yet committed), where reading
  // localStorage throws "Storage is disabled inside 'data:' URLs". Poll until
  // location.href settles on the okjike origin before probing the token.
  let pageUrl = '';
  for (let i = 0; i < 30; i++) {
    pageUrl = await page.evaluate('() => location.href');
    if (pageUrl.includes('okjike.com')) break;
    await page.wait(0.5);
  }
  if (!pageUrl.includes('okjike.com')) {
    await page.screenshot({ path: '/tmp/jike_whoami_nav_debug.png' });
    throw new CommandExecutionError(`Jike whoami: navigation never settled on okjike.com (landed on ${pageUrl}). Debug screenshot: /tmp/jike_whoami_nav_debug.png`);
  }
  // SPA hydrate race: JK_ACCESS_TOKEN is written to localStorage during the
  // app's auth bootstrap, which can lag behind navigation on slow boots. A
  // one-shot probe right after a fixed wait can read null even on a logged-in
  // profile. Poll with a bounded loop, breaking as soon as the probe resolves
  // to a non-anonymous result; only the final probe is treated as authoritative.
  let probe = await page.evaluate(WHOAMI_PROBE);
  for (let i = 0; i < 30 && probe?.kind === 'auth'; i++) {
    await page.wait(0.5);
    probe = await page.evaluate(WHOAMI_PROBE);
  }
  if (probe?.kind === 'auth') throw new AuthRequiredError('web.okjike.com', probe.detail);
  if (probe?.kind === 'http') throw new CommandExecutionError(`HTTP ${probe.httpStatus} from Jike users/profile`);
  if (probe?.kind === 'exception') {
    // When the profile is anonymous, okjike redirects to /login and replaces the
    // document with a blank "data:text/html,<html></html>" page, where reading
    // localStorage throws "Storage is disabled inside 'data:' URLs". That is the
    // not-logged-in signal, not a generic execution failure — surface it as such
    // so callers get an actionable AUTH_REQUIRED instead of an opaque error.
    const probeUrl = await page.evaluate('() => location.href');
    if (/^data:/.test(probeUrl) || /\/login/.test(pageUrl)) {
      throw new AuthRequiredError('web.okjike.com', 'Jike session anonymous (redirected to /login)');
    }
    throw new CommandExecutionError(`Jike whoami failed: ${probe.detail}`);
  }
  if (!probe?.ok) throw new CommandExecutionError(`Unexpected Jike probe: ${JSON.stringify(probe)}`);
  return { user_id: probe.user_id, screen_name: probe.screen_name, username: probe.username };
}

registerSiteAuthCommands({
  site: 'jike',
  domain: 'web.okjike.com',
  loginUrl: 'https://web.okjike.com/login',
  columns: ['user_id', 'screen_name', 'username'],
  verify: verifyJikeIdentity,
  poll: async (page) => {
    const probe = await page.evaluate(WHOAMI_PROBE);
    if (!probe?.ok) throw new AuthRequiredError('web.okjike.com', 'Waiting for Jike login');
    return { user_id: probe.user_id, screen_name: probe.screen_name, username: probe.username };
  },
});
