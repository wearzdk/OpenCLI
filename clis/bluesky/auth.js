import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerTokenAuth, requireCredentials } from '../_shared/token-auth.js';

// Bluesky / AT Protocol 鉴权：app-password（在 bsky 设置里生成，可吊销、不等于主密码）。
// app-password 不过期，所以「每次操作现建 session」最薄——免去 accessJwt/refreshJwt 的
// 刷新与过期管理。凭证只存 service + 账号 + app-password。

export const DEFAULT_SERVICE = 'https://bsky.social';

/** 归一化 PDS 服务地址（允许用户填裸 host）。 */
export function resolveService(creds) {
  const raw = (creds.service || DEFAULT_SERVICE).trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

/**
 * 用 app-password 建一个 AT Proto session。
 * @returns {{ service, accessJwt, did, handle }}
 */
export async function createSession(creds) {
  const service = resolveService(creds);
  let res;
  try {
    res = await fetch(`${service}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: creds.identifier, password: creds.password }),
    });
  } catch (err) {
    throw new CommandExecutionError(`Bluesky session request failed: ${err?.message ?? err}`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 400) {
    throw new AuthRequiredError(
      'bsky.app',
      `Bluesky login rejected (${body?.error ?? res.status}): ${body?.message ?? 'check handle + app-password'}`,
    );
  }
  if (!res.ok || !body?.accessJwt) {
    throw new CommandExecutionError(`Bluesky createSession failed (HTTP ${res.status}): ${body?.message ?? 'unknown error'}`);
  }
  return { service, accessJwt: body.accessJwt, did: body.did, handle: body.handle };
}

/** 取凭证并建 session（发布命令用）。 */
export async function authedSession() {
  return createSession(requireCredentials('bluesky'));
}

registerTokenAuth({
  site: 'bluesky',
  domain: 'bsky.app',
  fields: [
    { name: 'identifier', required: true, help: 'Bluesky handle or email (e.g. alice.bsky.social)' },
    { name: 'password', required: true, help: 'App password from Settings → App Passwords (NOT your main password)' },
    { name: 'service', required: false, default: DEFAULT_SERVICE, help: `PDS service URL (default ${DEFAULT_SERVICE})` },
  ],
  identityColumns: ['did', 'handle'],
  loginDescription: 'Configure Bluesky with a handle + app password (no browser).',
  validate: async (creds) => {
    const session = await createSession(creds);
    return { did: session.did, handle: session.handle };
  },
});
