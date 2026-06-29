import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerTokenAuth, requireCredentials } from '../_shared/token-auth.js';

// Mastodon（及兼容实例：Pleroma/Akkoma/GoToSocial 等）鉴权：实例 URL + access token。
// access token 在「设置 → 开发 → 新建应用」里生成（勾 write:statuses + write:media + read:accounts）。
// 开放协议——每个实例同一套 API，凭证里带上实例 URL（多实例的关键）。

/** 归一化实例地址（允许裸 host），去掉尾斜杠。 */
export function resolveInstance(creds) {
  const raw = String(creds.instance || '').trim().replace(/\/+$/, '');
  if (!raw) throw new AuthRequiredError('mastodon', 'Missing --instance (your Mastodon instance URL)');
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

/** 已配置凭证的 {instance, token}。 */
export function mastodonCreds() {
  const creds = requireCredentials('mastodon');
  return { instance: resolveInstance(creds), token: creds.token };
}

/** Bearer fetch 包装：自动加鉴权头，401/403 → AuthRequiredError。 */
export async function mastoFetch({ instance, token }, apipath, init = {}) {
  let res;
  try {
    res = await fetch(`${instance}${apipath}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
  } catch (err) {
    throw new CommandExecutionError(`Mastodon request failed (${apipath}): ${err?.message ?? err}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthRequiredError('mastodon', `Mastodon rejected the access token (HTTP ${res.status}) on ${apipath}`);
  }
  return res;
}

registerTokenAuth({
  site: 'mastodon',
  domain: 'joinmastodon.org',
  fields: [
    { name: 'instance', required: true, help: 'Instance URL, e.g. https://mastodon.social' },
    { name: 'token', required: true, help: 'Access token (Settings → Development; needs write:statuses, write:media)' },
  ],
  identityColumns: ['id', 'username', 'acct', 'instance'],
  loginDescription: 'Configure a Mastodon instance + access token (no browser).',
  validate: async (creds) => {
    const ctx = { instance: resolveInstance(creds), token: creds.token };
    const res = await mastoFetch(ctx, '/api/v1/accounts/verify_credentials');
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.id) {
      throw new CommandExecutionError(`Mastodon verify_credentials failed (HTTP ${res.status}): ${body?.error ?? 'unknown error'}`);
    }
    return { id: body.id, username: body.username, acct: body.acct, instance: ctx.instance };
  },
});
