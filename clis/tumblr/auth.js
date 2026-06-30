/**
 * Tumblr 鉴权 —— [pp-only] 从「OAuth1 四件套 token（registerTokenAuth）」改成
 * 「复用浏览器登录态（Strategy.COOKIE）」：用户在 Chrome 里登录 tumblr.com，会话 cookie
 * 自动驱动写操作，不再要求去 tumblr.com/oauth/apps 注册 app + 走授权拿四个密钥。
 *
 * 与官方 Web 仪表盘同源：登录后页面挂着 `window.tumblr.apiFetch(resource, init)`，它内部带好
 * Authorization: Bearer + X-CSRF（运行时现取、自动续期），我们直接复用，不必从 bootstrap 抠 token。
 * 参考 XKit-Rewritten（GPL-3.0）`src/main_world/api_fetch.js` 与 `src/utils/user.js`：
 *   - apiFetch('/v2/user/info') → response.user（name / blogs[] / primary 博客）。
 *   - 见 https://github.com/AprilSylph/XKit-Rewritten/blob/master/src/main_world/api_fetch.js
 *     与 https://github.com/AprilSylph/XKit-Rewritten/blob/master/src/utils/user.js
 *
 * 登录态判定：登录后 tumblr.com 种 `logged_in=1`（匿名为 0 或不存在），page.getCookies 可读。
 *
 * 真机 verify：`opencli tumblr login` → `opencli tumblr whoami` 显示 name + 主博客
 *   → `opencli tumblr publish --title ... --text ...`（先草稿后发布）。
 */
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

const HOME = 'https://www.tumblr.com';
const DASHBOARD = 'https://www.tumblr.com/dashboard';

// 登录态判定：tumblr.com 登录后种 `logged_in=1`（匿名时为 "0" 或缺失）。
async function hasTumblrSession(page) {
  const cookies = await page.getCookies({ url: HOME });
  const c = cookies.find((x) => x.name === 'logged_in');
  return !!(c && c.value && c.value !== '0');
}

/**
 * 读当前登录用户：打开已登录的仪表盘（同源），用页面自带的 window.tumblr.apiFetch
 * 打 /v2/user/info 拿 name + 博客列表（apiFetch 内部带 Bearer + CSRF，credentials 同源）。
 */
async function readTumblrUser(page) {
  await page.goto(DASHBOARD);
  const probe = await page.evaluate(`(async () => {
    try {
      if (!(window.tumblr && typeof window.tumblr.apiFetch === 'function')) {
        return { ok: false, reason: 'apiFetch unavailable — not on a logged-in tumblr page?' };
      }
      var r = await window.tumblr.apiFetch('/v2/user/info');
      var u = (r && r.response && r.response.user) || null;
      if (!u || !u.name) return { ok: false, reason: 'anonymous' };
      var blogs = (u.blogs || []).map(function (b) {
        return { name: String(b.name || ''), primary: !!b.primary, uuid: String(b.uuid || '') };
      });
      var primary = blogs.filter(function (b) { return b.primary; })[0] || blogs[0] || null;
      return {
        ok: true,
        name: String(u.name),
        primary_blog: primary ? primary.name : '',
        blogs: blogs.map(function (b) { return b.name; }).join(','),
      };
    } catch (e) {
      var status = e && e.status;
      if (status === 401 || status === 403) return { ok: false, reason: 'HTTP ' + status };
      return { ok: false, reason: String((e && e.message) || e) };
    }
  })()`);
  if (!probe || !probe.ok) {
    throw new AuthRequiredError('tumblr.com', `Not logged in (${probe ? probe.reason : 'no probe'})`);
  }
  return { name: probe.name, primary_blog: probe.primary_blog, blogs: probe.blogs };
}

registerSiteAuthCommands({
  site: 'tumblr',
  domain: 'tumblr.com',
  loginUrl: 'https://www.tumblr.com/login',
  columns: ['name', 'primary_blog', 'blogs'],
  loginDescription: '打开 Tumblr 登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
  quickCheck: hasTumblrSession,
  verify: readTumblrUser,
  poll: async (page) => {
    if (!await hasTumblrSession(page)) {
      throw new AuthRequiredError('tumblr.com', 'Waiting for tumblr.com session cookie');
    }
    return readTumblrUser(page);
  },
});
