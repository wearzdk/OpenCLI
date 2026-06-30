import * as crypto from 'node:crypto';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerTokenAuth, requireCredentials } from '../_shared/token-auth.js';

// Tumblr 鉴权：OAuth1.0a（consumer key/secret + oauth token/token secret，在
// tumblr.com/oauth/apps 注册 app + 走一次授权拿 token）。NPF v2 API。参考 pytumblr2（Apache-2.0）。
// ⚠️ 安全：四个 OAuth1 密钥明文落 ~/.opencli/sites/tumblr/credentials.json（0600），经中转可达——
// whoami 只回 user name + blog 列表，绝不回显密钥。

export const TUMBLR_API = 'https://api.tumblr.com/v2';

// RFC3986 严格百分号编码（OAuth1 要求，encodeURIComponent 不编码 !*'() ）。
function pctEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * 生成 OAuth1 Authorization 头。JSON body 的 POST 不把 body 纳入签名（只签 oauth_* 参数 +
 * URL query），与 requests_oauthlib(json=) / tumblr.js 行为一致。
 * @param {object} creds {consumer_key, consumer_secret, oauth_token, oauth_token_secret}
 */
export function oauth1Header(method, url, creds, extraParams = {}) {
  const oauthParams = {
    oauth_consumer_key: creds.consumer_key,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.oauth_token,
    oauth_version: '1.0',
  };
  // 签名基串：所有 oauth_* 参数 + URL query 参数（本适配器 URL 无 query），不含 JSON body。
  const allParams = { ...oauthParams, ...extraParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(allParams[k])}`)
    .join('&');
  const baseString = [method.toUpperCase(), pctEncode(url), pctEncode(paramString)].join('&');
  const signingKey = `${pctEncode(creds.consumer_secret)}&${pctEncode(creds.oauth_token_secret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  const header = { ...oauthParams, oauth_signature: signature };
  return 'OAuth ' + Object.keys(header).map((k) => `${pctEncode(k)}="${pctEncode(header[k])}"`).join(', ');
}

/** OAuth1 签名后打 Tumblr API；统一错误归一。 */
export async function tumblrFetch(creds, method, pathOrUrl, jsonBody) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${TUMBLR_API}${pathOrUrl}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: oauth1Header(method, url, creds),
        ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
    });
  } catch (err) {
    throw new CommandExecutionError(`Tumblr API request failed: ${err?.message ?? err}`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new AuthRequiredError('tumblr.com', `Tumblr rejected the OAuth1 credentials (HTTP 401): ${body?.meta?.msg ?? 'check the 4 keys'}`);
  }
  if (!res.ok) {
    throw new CommandExecutionError(`Tumblr API HTTP ${res.status}: ${body?.meta?.msg ?? body?.errors?.[0]?.detail ?? ''}`);
  }
  return body.response ?? body;
}

export function tumblrCreds() {
  return requireCredentials('tumblr');
}

/** blog 标识符归一化为 {name}.tumblr.com（已含点的原样）。 */
export function blogHost(name) {
  const n = String(name).trim();
  return n.includes('.') ? n : `${n}.tumblr.com`;
}

registerTokenAuth({
  site: 'tumblr',
  domain: 'tumblr.com',
  fields: [
    { name: 'consumer_key', required: true, help: 'OAuth consumer key (from tumblr.com/oauth/apps)' },
    { name: 'consumer_secret', required: true, help: 'OAuth consumer secret' },
    { name: 'oauth_token', required: true, help: 'OAuth access token' },
    { name: 'oauth_token_secret', required: true, help: 'OAuth access token secret' },
    { name: 'default_blog', required: false, help: 'Default blog identifier for posting (else primary blog)' },
  ],
  identityColumns: ['name', 'blogs', 'default_blog'],
  loginDescription: 'Configure Tumblr with OAuth1 consumer + token credentials (no browser).',
  validate: async (creds) => {
    const info = await tumblrFetch(creds, 'GET', '/user/info');
    const user = info.user ?? {};
    const blogs = (user.blogs ?? []).map((b) => b.name);
    const primary = (user.blogs ?? []).find((b) => b.primary)?.name ?? blogs[0] ?? '';
    return { name: user.name ?? '', blogs: blogs.join(','), default_blog: creds.default_blog || primary };
  },
});
