/**
 * Hashnode auth —— login + whoami 复用浏览器里的 Auth.js(NextAuth) 会话。
 *
 * [pp-only] 从「Personal Access Token（registerTokenAuth）」改成「复用 Chrome 登录态
 * （Strategy.COOKIE）」：用户在 Chrome 里登录 hashnode.com 后，httpOnly 的 NextAuth
 * 会话 cookie 自动驱动写操作，不再要求去 Settings → Developer 手动生成 PAT。
 *
 * 背景（务必知道，否则会走错路）：
 *   - Hashnode 已于 2026-05-13 把公共 GraphQL API（gql.hashnode.com）改成 **付费 Pro 专享**，
 *     免费账号无论用 PAT 还是会话都打不动（changelog: 2026-05-13-graphql-api-paid-access）。
 *   - 而且 gql.hashnode.com 与 hashnode.com **跨域**，浏览器页面内 fetch 会被 CORS 直接拦死
 *     （真机实测 `Failed to fetch`）。
 *   - `/api/auth/session` 只回**身份**（user.{name,email,id,username,onboardingDone}），
 *     **没有任何 accessToken/JWT 字段**（真机 karentia 实测坐实）——所以也无从「抠 JWT 打 gql」。
 *   因此发布只能走 **Web 编辑器 DOM 自动化**，见 publish.js（照搬 codenameone 的浏览器登录态方案）。
 *
 * 身份来源：page.evaluate 内同源 fetch('/api/auth/session', {credentials:'include'})
 *   → body.user.{username,name,id,email}。匿名时返回 {} 或无 user。
 *
 * 真机 verify：`opencli hashnode login` → `opencli hashnode whoami` 显示 username=karentia。
 */
import { AuthRequiredError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

const HOME = 'https://hashnode.com';
const SESSION_URL = 'https://hashnode.com/api/auth/session';

// Hashnode 登录后种的会话 cookie：真机实测名为 `hashnode-session`（httpOnly，
// document.cookie 读不到，但 page.getCookies 能拿）。它家用的是 Auth.js(NextAuth)，
// 另外还有 `__Host-authjs.csrf-token` / `__Secure-authjs.callback-url` 等辅助 cookie，
// 但真正的会话凭据是 `hashnode-session`。为兼容潜在版本差异，也认 authjs 的 session-token。
function isSessionCookie(name) {
  return name === 'hashnode-session' || /(authjs|next-auth)\.session-token$/.test(name);
}

async function hasHashnodeSession(page) {
  const cookies = await page.getCookies({ url: HOME });
  return cookies.some((c) => isSessionCookie(c.name) && c.value);
}

/** 同源 fetch /api/auth/session → user.{username,name,id}。匿名时抛 AuthRequiredError。 */
async function readHashnodeUser(page) {
  await page.goto(HOME);
  const probe = await page.evaluate(`(async () => {
    try {
      var r = await fetch(${JSON.stringify(SESSION_URL)}, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (r.status === 401 || r.status === 403) return { ok: false, reason: 'HTTP ' + r.status };
      var text = await r.text();
      var j = null; try { j = JSON.parse(text); } catch (e) { return { ok: false, reason: 'non-JSON session' }; }
      var u = j && j.user;
      if (!u || !u.username) return { ok: false, reason: 'anonymous' };
      return { ok: true, id: String(u.id || ''), username: String(u.username || ''), name: String(u.name || ''), email: String(u.email || '') };
    } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  })()`);
  if (!probe || !probe.ok) {
    throw new AuthRequiredError('hashnode.com', `Not logged in (${probe ? probe.reason : 'no probe'})`);
  }
  return { user_id: probe.id, username: probe.username, name: probe.name };
}

registerSiteAuthCommands({
  site: 'hashnode',
  domain: 'hashnode.com',
  loginUrl: 'https://hashnode.com/onboard',
  columns: ['user_id', 'username', 'name'],
  loginDescription: '打开 Hashnode 登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
  quickCheck: hasHashnodeSession,
  verify: readHashnodeUser,
  poll: async (page) => {
    if (!await hasHashnodeSession(page)) {
      throw new AuthRequiredError('hashnode.com', 'Waiting for hashnode.com session cookie');
    }
    return readHashnodeUser(page);
  },
});
