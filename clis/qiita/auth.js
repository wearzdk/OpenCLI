import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerTokenAuth, requireCredentials } from '../_shared/token-auth.js';

// Qiita 鉴权：个人访问令牌 PAT（Settings → Applications → 个人用アクセストークン，
// 需勾选 write_qiita 才能发布）。Bearer 头。参考官方 increments/qiita-cli（Apache-2.0）。
// ⚠️ 安全：token 明文落 ~/.opencli/sites/qiita/credentials.json（0600），经中转可达——
// whoami 只回 id/name，绝不回显 token。

export const QIITA_API = 'https://qiita.com/api/v2';

export function qiitaToken() {
  return requireCredentials('qiita').token;
}

export async function qiitaFetch(token, pathOrUrl, init = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${QIITA_API}${pathOrUrl}`;
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (err) {
    throw new CommandExecutionError(`Qiita API request failed: ${err?.message ?? err}`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new AuthRequiredError('qiita.com', `Qiita rejected the token (HTTP 401): ${body?.message ?? 'check the PAT / write_qiita scope'}`);
  }
  if (!res.ok) {
    throw new CommandExecutionError(`Qiita API HTTP ${res.status}: ${body?.message ?? JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

registerTokenAuth({
  site: 'qiita',
  domain: 'qiita.com',
  fields: [
    { name: 'token', required: true, help: 'Qiita personal access token (needs write_qiita scope)' },
  ],
  identityColumns: ['id', 'name'],
  loginDescription: 'Configure Qiita with a personal access token (no browser).',
  validate: async (creds) => {
    const me = await qiitaFetch(creds.token, '/authenticated_user');
    return { id: me.id, name: me.name ?? '' };
  },
});
