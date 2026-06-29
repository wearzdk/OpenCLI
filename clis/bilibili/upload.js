/**
 * Bilibili video upload (投稿) — bridges the browser-login bilibili session to the
 * external `biliup` CLI (https://github.com/biliup/biliup, binary `biliup`).
 *
 * Design: reuse the SAME browser cookies that `bilibili login` / `auth status`
 * already manage — no second login realm. We read SESSDATA / bili_jct / DedeUserID
 * from the live browser session, materialise them into biliup's `cookies.json`
 * credential schema, then shell out to `biliup upload`. biliup owns the hard parts
 * (upload line selection, chunked upload, retry, submit); we stay a thin bridge.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

// Override for tests / non-standard installs; the desktop runtime puts `biliup` on PATH.
const BILIUP_BIN = process.env.PUBBRIDGE_BILIUP_BIN || 'biliup';
// biliup's upload submit authenticates with the web cookies (SESSDATA + bili_jct CSRF);
// DedeUserID identifies the account. These three are the minimum a web-cookie login needs.
const REQUIRED_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID'];

/**
 * Build biliup's `cookies.json` credential from browser cookies.
 * biliup reads `cookie_info.cookies[].name/value` (see biliup-rs credential.rs
 * `set_cookie`) and pulls SESSDATA / bili_jct from there for the web upload API.
 * @param {Array<{name?: string, value?: unknown}>} cookies from page.getCookies
 */
export function buildBiliupCredential(cookies) {
  const jar = new Map();
  for (const c of Array.isArray(cookies) ? cookies : []) {
    if (c && typeof c.name === 'string') jar.set(c.name, String(c.value ?? ''));
  }
  const missing = REQUIRED_COOKIES.filter((n) => !jar.get(n));
  if (missing.length) {
    throw new AuthRequiredError(
      'www.bilibili.com',
      `缺少 B站登录 cookie（${missing.join(', ')}）。请先在客户端登录哔哩哔哩。`,
    );
  }
  const cookieList = [...jar.entries()].map(([name, value]) => ({ name, value }));
  return {
    cookie_info: { cookies: cookieList },
    // biliup keeps an SSO list for cross-domain cookie sync; harmless when present.
    sso: [
      'https://passport.bilibili.com/api/v2/sso',
      'https://passport.biligame.com/api/v2/sso',
      'https://passport.bigfun.cn/api/v2/sso',
    ],
    // No app access_token from a web login; web submit doesn't need it. Keep the
    // shape valid so biliup can deserialise the file.
    token_info: {
      mid: Number(jar.get('DedeUserID')) || 0,
      access_token: '',
      refresh_token: '',
      expires_in: 0,
    },
    platform: 'web',
  };
}

function writeCredentialFile(cred) {
  const dir = path.join(os.homedir(), '.publishport', 'biliup');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'cookies.json');
  // Contains SESSDATA — keep it user-private.
  fs.writeFileSync(file, JSON.stringify(cred), { mode: 0o600 });
  return file;
}

function resolveFiles(kwargs) {
  const files = [String(kwargs.file ?? '').trim()];
  for (const extra of String(kwargs.more ?? '').split(',')) {
    const p = extra.trim();
    if (p) files.push(p);
  }
  return files.filter(Boolean);
}

cli({
  site: 'bilibili',
  name: 'upload',
  access: 'write',
  description:
    '投稿视频到 B站（复用客户端的浏览器登录态，底层用 biliup）。默认仅 dry-run 校验，加 --execute 才真正上传。',
  domain: 'www.bilibili.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'file', required: true, positional: true, help: '视频文件路径（多P 用 --more 追加）' },
    { name: 'title', help: '稿件标题（默认取文件名）' },
    { name: 'tag', required: true, help: '标签，逗号分隔（B站要求至少 1 个）' },
    { name: 'tid', type: 'number', help: '分区 id（如 201 科学科普；不传用 biliup 默认）' },
    { name: 'desc', help: '简介' },
    { name: 'cover', help: '封面图片路径（不传由 B站自动截取）' },
    { name: 'copyright', type: 'number', help: '1=自制 2=转载（默认 1）' },
    { name: 'source', help: '转载来源 URL（copyright=2 时建议填）' },
    { name: 'line', help: '上传线路：bda2/ws/qn/bldsa/tx/txa/bda/alia（不传自动选）' },
    { name: 'dtime', type: 'number', help: '定时发布的 10 位 unix 时间戳' },
    { name: 'more', help: '追加的视频文件（多P），逗号分隔多个路径' },
    { name: 'execute', type: 'boolean', help: '真正投稿；不带则只做 dry-run 校验' },
  ],
  columns: ['status', 'title', 'files', 'output'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('bilibili upload 需要浏览器会话');

    const files = resolveFiles(kwargs);
    if (!files.length) throw new ArgumentError('至少提供一个视频文件');
    for (const f of files) {
      if (!fs.existsSync(f)) throw new ArgumentError(`视频文件不存在: ${f}`);
    }
    if (kwargs.cover && !fs.existsSync(String(kwargs.cover))) {
      throw new ArgumentError(`封面文件不存在: ${kwargs.cover}`);
    }

    const tags = String(kwargs.tag ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!tags.length) throw new ArgumentError('B站投稿至少需要 1 个标签，用 --tag 传（逗号分隔）');

    const title = String(kwargs.title ?? '').trim() || path.basename(files[0]).replace(/\.[^.]+$/, '');

    // Reuse the existing browser login: export cookies → biliup credential.
    const cred = buildBiliupCredential(await page.getCookies({ url: 'https://www.bilibili.com' }));

    if (!kwargs.execute) {
      return {
        status: 'dry-run',
        title,
        files: files.join(', '),
        output: `校验通过：登录态有效、${files.length} 个文件就绪、标签 [${tags.join(', ')}]。加 --execute 真正投稿。`,
      };
    }

    const credFile = writeCredentialFile(cred);
    const args = ['-u', credFile, 'upload', ...files, '--title', title, '--tag', tags.join(',')];
    if (kwargs.desc) args.push('--desc', String(kwargs.desc));
    if (kwargs.tid != null && kwargs.tid !== '') args.push('--tid', String(kwargs.tid));
    if (kwargs.cover) args.push('--cover', String(kwargs.cover));
    if (kwargs.copyright != null && kwargs.copyright !== '') args.push('--copyright', String(kwargs.copyright));
    if (kwargs.source) args.push('--source', String(kwargs.source));
    if (kwargs.line) args.push('--line', String(kwargs.line));
    if (kwargs.dtime != null && kwargs.dtime !== '') args.push('--dtime', String(kwargs.dtime));

    const res = spawnSync(BILIUP_BIN, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.error) {
      if (res.error.code === 'ENOENT') {
        throw new CommandExecutionError(
          `未找到 biliup 二进制（${BILIUP_BIN}）。客户端运行时应已自动安装；也可设 PUBBRIDGE_BILIUP_BIN 指向可执行文件。`,
        );
      }
      throw new CommandExecutionError(`调用 biliup 失败: ${res.error.message}`);
    }
    const out = `${res.stdout ?? ''}${res.stderr ? `\n${res.stderr}` : ''}`.trim();
    if (res.status !== 0) {
      throw new CommandExecutionError(`biliup 投稿失败（exit ${res.status}）:\n${out}`);
    }
    return { status: 'uploaded', title, files: files.join(', '), output: out };
  },
});
