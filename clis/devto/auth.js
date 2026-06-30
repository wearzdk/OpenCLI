import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerTokenAuth, requireCredentials } from '../_shared/token-auth.js';

// DEV.to 鉴权：API key（在 dev.to → Settings → Extensions → DEV Community API Keys 生成）。
// 所有写操作把它放进 `api-key` 请求头。参考 sinedied/devto-cli（MIT）。
// ⚠️ 安全：api key 明文落 ~/.opencli/sites/devto/credentials.json（0600），经中转可达——
// whoami 只回 id/username/name，绝不回显 key。

export const DEVTO_API = 'https://dev.to/api';

/** 取已配置的 api key（写命令用）。 */
export function devtoApiKey() {
  return requireCredentials('devto').api_key;
}

/** 带 api-key 头打 DEV.to API，统一错误归一。 */
export async function devtoFetch(apiKey, pathOrUrl, init = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${DEVTO_API}${pathOrUrl}`;
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.forem.api-v1+json',
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new CommandExecutionError(`DEV.to API request failed: ${err?.message ?? err}`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new AuthRequiredError('dev.to', `DEV.to rejected the api key (HTTP 401): ${body?.error ?? 'check the key'}`);
  }
  if (!res.ok) {
    throw new CommandExecutionError(`DEV.to API HTTP ${res.status}: ${body?.error ?? JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

registerTokenAuth({
  site: 'devto',
  domain: 'dev.to',
  fields: [
    { name: 'api_key', required: true, help: 'DEV.to API key (Settings → Extensions → DEV Community API Keys)' },
  ],
  identityColumns: ['id', 'username', 'name'],
  loginDescription: 'Configure DEV.to with an API key (no browser).',
  validate: async (creds) => {
    const me = await devtoFetch(creds.api_key, '/users/me');
    return { id: me.id, username: me.username, name: me.name ?? '' };
  },
});
