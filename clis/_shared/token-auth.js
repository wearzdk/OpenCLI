import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError } from '@jackwener/opencli/errors';

// ── 凭证 / token 类（非浏览器）平台的共享鉴权基建 ──────────────────────────────
//
// 协议开放平台（Bluesky / Mastodon / Telegram / Nostr / Farcaster …）没有「浏览器
// cookie 登录态」，鉴权靠 app-password / access token / bot token / 私钥这类凭证。
// opencli 原生的 site-auth / article-login 都假定开浏览器验 cookie，对它们不适用。
//
// 这里提供一套对称物：凭证落盘 + `login`（录入并校验凭证）+ `whoami`（读盘校验，
// 喂 `auth status` 让桌面绿点亮）。三者都是 `Strategy.LOCAL` 非浏览器命令，零 Chrome。
//
// 配套的 core 改动：src/commands/auth.ts 已放宽 `auth status` 的发现/探测逻辑，
// 让非浏览器 whoami 也能被识别为登录态探针（见该文件 authWhoamiCommands / runQuick）。
//
// ⚠️ 安全：凭证明文落在 ~/.opencli/sites/<site>/credentials.json（权限 0600）。
// 经 PublishPort 中转的 local_bash 能读到它——中转鉴权是唯一闸门，别在任何输出 / 日志
// 里回显这些凭证（whoami/login 只返回脱敏 identity，不返回原始凭证）。

function credPath(site) {
  return path.join(os.homedir(), '.opencli', 'sites', site, 'credentials.json');
}

/** 读取已存凭证；未配置返回 null。 */
export function loadCredentials(site) {
  try {
    return JSON.parse(fs.readFileSync(credPath(site), 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** 写入凭证（0600，仅本用户可读）。 */
export function saveCredentials(site, creds) {
  const file = credPath(site);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  // mkdir 早于 writeFile 时已存在的文件不会被重设权限，显式收一次。
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
}

/** 删除已存凭证；存在并删除返回 true，本就没有返回 false。 */
export function clearCredentials(site) {
  try { fs.rmSync(credPath(site)); return true; } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

/** 发布等命令取凭证用；未配置抛 AuthRequiredError（统一引导去 login）。 */
export function requireCredentials(site) {
  const creds = loadCredentials(site);
  if (!creds) {
    throw new AuthRequiredError(
      site,
      `${site} not configured. Run \`opencli ${site} login\` with your credentials first.`,
    );
  }
  return creds;
}

/**
 * 给一个凭证 / token 类平台注册 `login` + `whoami` 两个非浏览器命令。
 *
 * @param {object} config
 * @param {string} config.site      站点 id（如 'bluesky'）
 * @param {string} config.domain    主域名（favicon / 文档用）
 * @param {Array<{name:string, required?:boolean, help?:string, default?:unknown}>} config.fields
 *        登录凭证字段——每个字段成为 `login --<name> <value>` 的一个参数。
 * @param {(creds:Record<string,any>) => Promise<Record<string,any>>} config.validate
 *        拿凭证打平台 API 校验：成功返回脱敏 identity（如 {id, username, name}），
 *        失败抛 AuthRequiredError。**绝不能把原始凭证放进返回值。**
 * @param {string[]} [config.identityColumns]  identity 列（默认 id/username/name）
 * @param {string} [config.loginDescription]
 * @param {string} [config.whoamiDescription]
 */
export function registerTokenAuth(config) {
  if (!config?.site || !config?.domain || !Array.isArray(config.fields) || typeof config.validate !== 'function') {
    throw new Error('registerTokenAuth requires site, domain, fields[], and validate(creds)');
  }
  const identityColumns = config.identityColumns ?? ['id', 'username', 'name'];

  // whoami —— 读盘 → validate → identity。被 `auth status` 当登录态探针调用。
  cli({
    site: config.site,
    name: 'whoami',
    access: 'read',
    description: config.whoamiDescription ?? `Show the configured ${config.site} account`,
    domain: config.domain,
    strategy: Strategy.LOCAL,
    browser: false,
    args: [],
    columns: ['logged_in', 'site', ...identityColumns],
    func: async () => {
      const creds = requireCredentials(config.site); // 未配置 → AuthRequiredError → not_logged_in
      const identity = await config.validate(creds); // 凭证失效 → AuthRequiredError
      return { logged_in: true, site: config.site, ...identity };
    },
  });

  // login —— 录入凭证 flag → validate → 落盘。非浏览器，不开窗口。
  cli({
    site: config.site,
    name: 'login',
    access: 'write',
    description: config.loginDescription
      ?? `Configure ${config.site} credentials (token/key based, no browser). Pass each field as a flag.`,
    domain: config.domain,
    strategy: Strategy.LOCAL,
    browser: false,
    // required 一律设 false：手动校验后给出聚合的「缺哪些 flag」错误，比逐个报错友好；
    // 也允许只传部分字段来「增量更新」已存凭证（如换 token 但复用实例 URL）。
    args: config.fields.map((field) => ({
      name: field.name,
      type: 'string',
      required: false,
      help: field.help ?? `${config.site} ${field.name}`,
      ...(field.default !== undefined ? { default: field.default } : {}),
    })),
    columns: ['status', 'logged_in', 'site', ...identityColumns],
    func: async (kwargs) => {
      const stored = loadCredentials(config.site) ?? {};
      const creds = {};
      for (const field of config.fields) {
        // 优先用户本次传入 → 已存凭证 → 字段默认值（不依赖 commander 注入默认，
        // 直接编程调用 / 测试时也一致）。
        const value = kwargs[field.name] ?? stored[field.name] ?? field.default;
        if (value !== undefined && value !== null && value !== '') creds[field.name] = value;
      }
      const missing = config.fields.filter(
        (field) => field.required !== false && creds[field.name] === undefined,
      );
      if (missing.length) {
        throw new ArgumentError(
          `Missing required credential(s): ${missing.map((field) => `--${field.name}`).join(', ')}`,
          `Run \`opencli ${config.site} login -h\` to see all fields.`,
        );
      }
      const identity = await config.validate(creds); // 校验失败抛错，不落盘
      saveCredentials(config.site, creds);
      return {
        status: Object.keys(stored).length ? 'updated' : 'login_complete',
        logged_in: true,
        site: config.site,
        ...identity,
      };
    },
  });
}
