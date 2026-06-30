/**
 * dev.to (Forem) auth — login + whoami over the browser session cookie.
 *
 * [pp-only] 从「API key（registerTokenAuth）」改成「复用浏览器登录态（Strategy.COOKIE）」：
 * 用户在 Chrome 里登录 dev.to，会话 cookie（Devise `remember_user_token` / `_Forem_Session`）
 * 自动驱动写操作，不再要求去 Settings → Extensions 手动生成 DEV Community API Key。这与
 * Forem 自家 web 编辑器同源（`POST /articles` + `meta[name=csrf-token]`，见 publish.js）。
 *
 * 身份来源：Forem 把当前登录用户的 JSON 注入到 `<body data-user="...">`（id/username/name），
 * 同源页面直接读，无需任何 token。
 *
 * 真机 verify：`opencli devto login` → `opencli devto whoami` 显示 username
 *   → `opencli devto publish --title ... --body ...`（先草稿后发布）。
 */
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

const HOME = 'https://dev.to';

// 登录态判定：Forem 用 Devise，登录后种 `remember_user_token`（HttpOnly，document.cookie 读不到，
// 但 page.getCookies 能拿）。`_Forem_Session` 即便匿名也可能存在，故只认 remember_user_token。
async function hasDevtoSession(page) {
  const cookies = await page.getCookies({ url: HOME });
  return cookies.some((c) => c.name === 'remember_user_token' && c.value);
}

/** 读 `<body data-user>` 拿当前登录用户（id/username/name）。匿名时 data-user 为空或无 id。 */
async function readDevtoUser(page) {
  await page.goto(HOME);
  const probe = await page.evaluate(`(() => {
    try {
      var du = document.body && document.body.getAttribute('data-user');
      if (!du) return { ok: false, reason: 'no data-user' };
      var u = JSON.parse(du);
      if (!u || u.id == null) return { ok: false, reason: 'anonymous' };
      return { ok: true, id: String(u.id), username: String(u.username || ''), name: String(u.name || '') };
    } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  })()`);
  if (!probe || !probe.ok) {
    throw new AuthRequiredError('dev.to', `Not logged in (${probe ? probe.reason : 'no probe'})`);
  }
  return { user_id: probe.id, username: probe.username, name: probe.name };
}

registerSiteAuthCommands({
  site: 'devto',
  domain: 'dev.to',
  loginUrl: 'https://dev.to/enter',
  columns: ['user_id', 'username', 'name'],
  loginDescription: '打开 dev.to 登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
  quickCheck: hasDevtoSession,
  verify: readDevtoUser,
  poll: async (page) => {
    if (!await hasDevtoSession(page)) {
      throw new AuthRequiredError('dev.to', 'Waiting for dev.to session cookie');
    }
    return readDevtoUser(page);
  },
});
