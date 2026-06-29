/**
 * Kuaishou (快手) creator-center auth — login / whoami.
 *
 * Mirrors upstream social-auto-upload ks_uploader cookie_auth: a session is
 * valid when the creator upload page loads without bouncing to the passport
 * login flow. Requires the user to be logged into cp.kuaishou.com in Chrome.
 */
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { currentUrl } from '../_shared/video-publish.js';

const UPLOAD_URL = 'https://cp.kuaishou.com/article/publish/video';

async function hasKuaishouCookie(page) {
  const cookies = await page.getCookies({ url: 'https://cp.kuaishou.com' });
  // Kuaishou creator center keeps its web session in *_st / userId cookies.
  return cookies.some((c) => c.value && (/_st$/.test(c.name) || c.name === 'userId' || c.name === 'kuaishou.web.cp.api_st'));
}

async function verifyKuaishouIdentity(page) {
  await page.goto(UPLOAD_URL);
  // Poll until navigation settles, then decide: a passport/login URL means the
  // session is gone; staying on cp.kuaishou.com/article means it is valid.
  let url = '';
  for (let i = 0; i < 30; i++) {
    url = await currentUrl(page);
    if (url && /cp\.kuaishou\.com\/article/.test(url)) {
      return { logged_in: true };
    }
    if (url && (/passport\.kuaishou\.com/.test(url) || /\/account\/login/.test(url))) {
      throw new AuthRequiredError('cp.kuaishou.com', '快手创作者平台需要登录');
    }
    await page.wait({ time: 0.5 });
  }
  throw new AuthRequiredError('cp.kuaishou.com', `快手登录态校验未 settle（当前: ${url || 'unknown'}）`);
}

registerSiteAuthCommands({
  site: 'kuaishou',
  domain: 'cp.kuaishou.com',
  loginUrl: 'https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api&callback=https%3A%2F%2Fcp.kuaishou.com%2Frest%2Finfra%2Fsts%3FfollowUrl%3Dhttps%253A%252F%252Fcp.kuaishou.com%252Farticle%252Fpublish%252Fvideo%26setRootDomain%3Dtrue',
  columns: ['logged_in'],
  quickCheck: hasKuaishouCookie,
  verify: verifyKuaishouIdentity,
  poll: async (page) => {
    if (!await hasKuaishouCookie(page)) {
      throw new AuthRequiredError('cp.kuaishou.com', '等待快手登录 cookie');
    }
    return verifyKuaishouIdentity(page);
  },
});
