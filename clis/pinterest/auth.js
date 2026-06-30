/**
 * Pinterest auth — login + whoami over the browser session cookie.
 *
 * Cookie login (Strategy.COOKIE): user signs in at pinterest.com in Chrome;
 * `_pinterest_sess` + `csrftoken` ride requests. Identity is read from the SPA
 * bootstrap (see client.resolvePinterestUser) — flagged for real-machine verify.
 *
 * Real-machine verify: `opencli pinterest login` → `opencli pinterest whoami`
 * → `opencli pinterest boards` lists your boards.
 */
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { resolvePinterestUser } from './client.js';

async function hasPinterestSession(page) {
  const cookies = await page.getCookies({ url: 'https://www.pinterest.com' });
  return cookies.some((c) => c.name === '_pinterest_sess');
}

async function verifyPinterestIdentity(page) {
  if (!await hasPinterestSession(page)) {
    throw new AuthRequiredError('www.pinterest.com', 'Pinterest _pinterest_sess cookie missing');
  }
  const username = await resolvePinterestUser(page);
  return { username, url: `https://www.pinterest.com/${username}/` };
}

registerSiteAuthCommands({
  site: 'pinterest',
  domain: 'www.pinterest.com',
  loginUrl: 'https://www.pinterest.com/login/',
  columns: ['username', 'url'],
  quickCheck: hasPinterestSession,
  verify: verifyPinterestIdentity,
  poll: async (page) => {
    if (!await hasPinterestSession(page)) {
      throw new AuthRequiredError('www.pinterest.com', 'Waiting for Pinterest session cookie');
    }
    return verifyPinterestIdentity(page);
  },
});
