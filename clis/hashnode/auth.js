import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerTokenAuth, requireCredentials } from '../_shared/token-auth.js';

// Hashnode 鉴权：Personal Access Token（hashnode.com/settings/developer 生成）。
// GraphQL 端点 https://gql.hashnode.com，token 放 Authorization 头（无 Bearer 前缀）。
// 参考 raunakgurud09/hashnode-publish（GraphQL publishPost）。
// ⚠️ 安全：PAT 明文落 ~/.opencli/sites/hashnode/credentials.json（0600），经中转可达——
// whoami 只回 id/username/name，绝不回显 token。

export const HASHNODE_GQL = 'https://gql.hashnode.com';

export function hashnodeToken() {
  return requireCredentials('hashnode').token;
}

/** GraphQL 请求；GraphQL 错误（HTTP 200 但 body.errors 非空）也归一抛出。 */
export async function hashnodeGql(token, query, variables = {}) {
  let res;
  try {
    res = await fetch(HASHNODE_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new CommandExecutionError(`Hashnode GraphQL request failed: ${err?.message ?? err}`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    throw new AuthRequiredError('hashnode.com', `Hashnode rejected the token (HTTP ${res.status}): check the PAT`);
  }
  if (Array.isArray(body.errors) && body.errors.length) {
    const msg = body.errors.map((e) => e.message).join('; ');
    if (/unauthor|not authenticated|invalid token/i.test(msg)) {
      throw new AuthRequiredError('hashnode.com', `Hashnode auth error: ${msg}`);
    }
    throw new CommandExecutionError(`Hashnode GraphQL error: ${msg}`);
  }
  if (!res.ok) throw new CommandExecutionError(`Hashnode GraphQL HTTP ${res.status}`);
  return body.data;
}

/**
 * 解析 publicationId：优先 --publication-id；其次按 host 查；最后取账号唯一的 publication。
 * 账号有多个且未指定时报错（让用户挑一个，不静默猜）。
 */
export async function resolvePublicationId(token, { id, host } = {}) {
  if (id) return String(id);
  if (host) {
    const data = await hashnodeGql(token, `query Pub($host:String!){ publication(host:$host){ id } }`, { host });
    if (!data?.publication?.id) throw new CommandExecutionError(`No Hashnode publication found for host "${host}"`);
    return data.publication.id;
  }
  const data = await hashnodeGql(token, `query { me { publications(first:5){ edges { node { id title url } } } } }`);
  const edges = data?.me?.publications?.edges ?? [];
  if (edges.length === 0) throw new CommandExecutionError('Your Hashnode account has no publication. Create one first.');
  if (edges.length > 1) {
    const list = edges.map((e) => `${e.node.title} (${e.node.url})`).join(', ');
    throw new CommandExecutionError(
      `Multiple publications found: ${list}. Pass --publication-id or --publication-host to choose one.`,
    );
  }
  return edges[0].node.id;
}

registerTokenAuth({
  site: 'hashnode',
  domain: 'hashnode.com',
  fields: [
    { name: 'token', required: true, help: 'Hashnode Personal Access Token (Settings → Developer)' },
  ],
  identityColumns: ['id', 'username', 'name'],
  loginDescription: 'Configure Hashnode with a Personal Access Token (no browser).',
  validate: async (creds) => {
    const data = await hashnodeGql(creds.token, `query { me { id username name } }`);
    if (!data?.me?.id) throw new AuthRequiredError('hashnode.com', 'Hashnode token did not resolve to a user');
    return { id: data.me.id, username: data.me.username ?? '', name: data.me.name ?? '' };
  },
});
