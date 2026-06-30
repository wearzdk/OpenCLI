import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerTokenAuth, requireCredentials } from '../_shared/token-auth.js';

// Threads 鉴权：Meta 官方 2024 API 的长效 access token（需在 developers.facebook.com 建 app、
// 走 Threads OAuth 拿 long-lived token）。逆向版全被 Meta 下架，只走官方 API。
// 参考 davidcelis/threads-api（MIT）。base https://graph.threads.net/v1.0。
// ⚠️ 安全：token 明文落 ~/.opencli/sites/threads/credentials.json（0600），经中转可达——
// whoami 只回 id/username，绝不回显 token。

export const THREADS_API = 'https://graph.threads.net/v1.0';

/** GET，access_token 走 query；统一错误归一。 */
export async function threadsGet(token, pathSeg, fields) {
  const url = new URL(`${THREADS_API}/${pathSeg}`);
  if (fields) url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', token);
  return threadsRequest('GET', url);
}

/** POST，参数走 query（Graph API 惯例）；统一错误归一。 */
export async function threadsPost(token, pathSeg, params = {}) {
  const url = new URL(`${THREADS_API}/${pathSeg}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('access_token', token);
  return threadsRequest('POST', url);
}

async function threadsRequest(method, url) {
  let res;
  try {
    res = await fetch(url, { method });
  } catch (err) {
    throw new CommandExecutionError(`Threads API request failed: ${err?.message ?? err}`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || body?.error?.type === 'OAuthException') {
    throw new AuthRequiredError('threads.net', `Threads rejected the token: ${body?.error?.message ?? 'check the long-lived access token'}`);
  }
  if (!res.ok) {
    throw new CommandExecutionError(`Threads API HTTP ${res.status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

/** 取凭证，并确保有 user_id（缺则用 token 查 /me 解析）。 */
export async function threadsAuth() {
  const creds = requireCredentials('threads');
  let userId = creds.user_id;
  let username = creds.username;
  if (!userId) {
    const me = await threadsGet(creds.token, 'me', 'id,username');
    userId = me.id;
    username = me.username;
  }
  return { token: creds.token, userId, username };
}

registerTokenAuth({
  site: 'threads',
  domain: 'threads.net',
  fields: [
    { name: 'token', required: true, help: 'Threads long-lived access token (Meta app)' },
    { name: 'user_id', required: false, help: 'Threads user id (auto-resolved via /me if omitted)' },
  ],
  identityColumns: ['id', 'username'],
  loginDescription: 'Configure Threads with a Meta long-lived access token (no browser).',
  validate: async (creds) => {
    const me = await threadsGet(creds.token, creds.user_id || 'me', 'id,username');
    if (!me?.id) throw new AuthRequiredError('threads.net', 'Threads token did not resolve to a user');
    return { id: me.id, username: me.username ?? '' };
  },
});
