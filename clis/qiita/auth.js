/**
 * Qiita auth — login + whoami over the browser session cookie.
 *
 * [pp-only] 从「PAT（registerTokenAuth + Bearer）」改成「复用浏览器登录态（Strategy.COOKIE）」：
 * 用户在 Chrome 登录 qiita.com，会话 cookie `_qiita_login_session` 自动驱动写操作，不再要求去
 * Settings → Applications 手动生成带 write_qiita scope 的个人访问令牌。这与 Qiita 自家 web
 * 编辑器同源（`POST /graphql` + `meta[name=csrf-token]`，见 publish.js）。
 *
 * 身份来源：GraphQL `{ viewer { urlName name originalId } }`（同源、带 cookie），匿名时
 * 返回 `Login required` 错误。
 *
 * 真机 verify：`opencli qiita login` → `opencli qiita whoami` 显示 urlName
 *   → `opencli qiita publish ...`（先草稿后发布）。
 */
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';
import { qiitaViewer } from './gql.js';

const HOME = 'https://qiita.com';

// 登录态判定：Qiita 用 `_qiita_login_session` cookie 承载登录态（HttpOnly，page.getCookies 可读）。
async function hasQiitaSession(page) {
  const cookies = await page.getCookies({ url: HOME });
  return cookies.some((c) => c.name === '_qiita_login_session' && c.value);
}

/** 读 GraphQL viewer 拿当前登录用户。匿名时抛 AuthRequiredError。 */
async function readQiitaViewer(page) {
  await page.goto(`${HOME}/`);
  const v = await qiitaViewer(page);
  return { url_name: v.urlName, name: v.name || '', user_id: String(v.originalId ?? '') };
}

registerSiteAuthCommands({
  site: 'qiita',
  domain: 'qiita.com',
  loginUrl: 'https://qiita.com/login',
  columns: ['url_name', 'name', 'user_id'],
  loginDescription: '打开 Qiita 登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
  quickCheck: hasQiitaSession,
  verify: readQiitaViewer,
  poll: async (page) => {
    if (!await hasQiitaSession(page)) {
      throw new AuthRequiredError('qiita.com', 'Waiting for Qiita session cookie');
    }
    return readQiitaViewer(page);
  },
});
