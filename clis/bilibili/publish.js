/**
 * Bilibili (B站) video submission — `publish` + `biliup-login`.
 *
 * Faithfully ported from upstream social-auto-upload bilibili_uploader: that
 * project does NOT reverse-engineer B站's upload protocol itself — it downloads
 * the official `biliup` binary (github.com/biliup/biliup) for the host platform
 * and shells out to it. We mirror exactly that:
 *   • runtime.py  → ensureBiliupBinary(): platform key, release asset selection,
 *     download + extract + version cache.
 *   • sau_cli.py upload_bilibili_video → `biliup -u <cookie> upload <file>
 *     --title --desc --tid [--tag a,b] [--dtime <unix>]`.
 *
 * Non-browser command: B站 uses biliup's own cookie file (distinct from the
 * browser session the other bilibili read adapters use). Run `biliup-login` once.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { parseScheduleDate } from '../_shared/video-publish.js';

const GITHUB_RELEASE_API = 'https://api.github.com/repos/biliup/biliup/releases/latest';

function biliupRoot() {
  return path.join(os.homedir(), '.publishport', 'tools', 'biliup');
}

function normalizeSystem() {
  const p = process.platform;
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return p; // 'linux'
}

function normalizeMachine() {
  const m = (process.arch || '').toLowerCase();
  const aliases = { x64: 'x86_64', amd64: 'x86_64', arm64: 'aarch64' };
  return aliases[m] || m;
}

function platformKey() {
  return `${normalizeSystem()}-${normalizeMachine()}`;
}

function biliupBinaryPath() {
  const name = normalizeSystem() === 'windows' ? 'biliup.exe' : 'biliup';
  return path.join(biliupRoot(), platformKey(), name);
}

function biliupVersionPath() {
  return path.join(path.dirname(biliupBinaryPath()), 'version.txt');
}

function selectReleaseAsset(assets) {
  const key = platformKey();
  const preferred = {
    'windows-x86_64': ['x86_64-windows.zip'],
    'linux-x86_64': ['x86_64-linux.tar.xz'],
    'linux-aarch64': ['aarch64-linux.tar.xz'],
    'linux-arm': ['arm-linux.tar.xz'],
    'macos-x86_64': ['x86_64-macos.tar.xz'],
    'macos-aarch64': ['aarch64-macos.tar.xz'],
  }[key];
  if (!preferred) throw new CommandExecutionError(`biliup 不支持的平台: ${key}`);
  for (const asset of assets) {
    const name = asset.name || '';
    if (preferred.some((p) => name.includes(p))) {
      return { assetName: name, assetUrl: asset.browser_download_url || '' };
    }
  }
  throw new CommandExecutionError(`未找到匹配的 biliup 发布包: ${key}`);
}

async function fetchLatestRelease() {
  const res = await fetch(GITHUB_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'publishport' },
  });
  if (!res.ok) throw new CommandExecutionError(`获取 biliup release 失败: HTTP ${res.status}`);
  const payload = await res.json();
  const asset = selectReleaseAsset(payload.assets || []);
  return { tagName: payload.tag_name || '', ...asset };
}

function readLocalVersion() {
  try { return fs.readFileSync(biliupVersionPath(), 'utf-8').trim() || null; } catch { return null; }
}

function writeLocalVersion(version) {
  fs.mkdirSync(path.dirname(biliupVersionPath()), { recursive: true });
  fs.writeFileSync(biliupVersionPath(), version, 'utf-8');
}

function pickExecutable(extractRoot) {
  const wanted = new Set(['biliup', 'biliup.exe', 'biliupr', 'biliupr.exe']);
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (wanted.has(entry.name.toLowerCase())) found.push(full);
    }
  };
  walk(extractRoot);
  if (!found.length) throw new CommandExecutionError('下载的 biliup 包内未找到可执行文件');
  found.sort((a, b) => a.length - b.length);
  return found[0];
}

async function downloadBiliupAsset(release, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biliup-download-'));
  try {
    const archivePath = path.join(tmpDir, release.assetName);
    const res = await fetch(release.assetUrl);
    if (!res.ok) throw new CommandExecutionError(`下载 biliup 失败: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(archivePath, buf);

    const extractRoot = path.join(tmpDir, 'extract');
    fs.mkdirSync(extractRoot, { recursive: true });
    // bsdtar/GNU tar extract both .tar.xz (-xJf) and .zip (-xf). Branch by suffix.
    if (archivePath.toLowerCase().endsWith('.zip')) {
      execFileSync('tar', ['-xf', archivePath, '-C', extractRoot], { stdio: 'ignore' });
    } else {
      execFileSync('tar', ['-xJf', archivePath, '-C', extractRoot], { stdio: 'ignore' });
    }
    const bin = pickExecutable(extractRoot);
    const tmpBin = `${destination}.tmp`;
    fs.copyFileSync(bin, tmpBin);
    fs.renameSync(tmpBin, destination);
    if (normalizeSystem() !== 'windows') fs.chmodSync(destination, 0o755);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return destination;
}

async function ensureBiliupBinary(forceCheck = false) {
  const binaryPath = biliupBinaryPath();
  const localVersion = readLocalVersion();
  if (fs.existsSync(binaryPath) && !forceCheck) return binaryPath;
  let release;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    if (fs.existsSync(binaryPath)) return binaryPath; // GitHub rate-limit/offline → reuse local
    throw err;
  }
  if (fs.existsSync(binaryPath) && localVersion === release.tagName) return binaryPath;
  await downloadBiliupAsset(release, binaryPath);
  writeLocalVersion(release.tagName);
  return binaryPath;
}

function resolveCookiePath(kwargs) {
  if (kwargs.cookie) return path.resolve(String(kwargs.cookie));
  const account = String(kwargs.account || 'default');
  return path.join(os.homedir(), '.publishport', 'bilibili', `${account}.json`);
}

function parseScheduleUnix(raw) {
  const dt = parseScheduleDate(raw);
  return dt == null ? null : Math.floor(dt.getTime() / 1000);
}

cli({
  site: 'bilibili',
  name: 'publish',
  aliases: ['upload-video'],
  access: 'write',
  description: '投稿视频到B站（经官方 biliup；一条命令完成；需先 biliup-login）',
  browser: false,
  strategy: Strategy.LOCAL,
  args: [
    { name: 'video', required: true, positional: true, help: '视频文件路径' },
    { name: 'title', required: true, help: '稿件标题' },
    { name: 'desc', default: '', help: '稿件简介' },
    { name: 'tid', required: true, help: '分区 ID（B站 category id，如体育-足球=...）' },
    { name: 'tags', default: '', help: '标签，逗号分隔（tag1,tag2）' },
    { name: 'schedule', default: '', help: '定时发布时间（ISO8601 或 Unix 秒；不填即立即）' },
    { name: 'account', default: 'default', help: 'biliup 账号名（cookie 存 ~/.publishport/bilibili/<account>.json）' },
    { name: 'cookie', default: '', help: '直接指定 biliup cookie 文件路径（覆盖 --account）' },
  ],
  columns: ['status', 'title', 'tid'],
  func: async (kwargs) => {
    const videoPath = path.resolve(String(kwargs.video));
    if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
      throw new ArgumentError(`视频文件不存在: ${videoPath}`);
    }
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new ArgumentError('--title is required');
    const tid = String(kwargs.tid ?? '').trim();
    if (!tid || !/^\d+$/.test(tid)) throw new ArgumentError('--tid 必须是数字分区 ID');
    const cookiePath = resolveCookiePath(kwargs);
    if (!fs.existsSync(cookiePath)) {
      throw new CommandExecutionError(
        `B站 biliup cookie 不存在: ${cookiePath}。请先运行: opencli bilibili biliup-login --account ${kwargs.account || 'default'}`,
      );
    }
    const tags = kwargs.tags
      ? String(kwargs.tags).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const dtime = parseScheduleUnix(kwargs.schedule);

    const binary = await ensureBiliupBinary(false);
    const args = ['-u', cookiePath, 'upload', videoPath, '--title', title, '--desc', String(kwargs.desc || ''), '--tid', tid];
    if (tags.length) args.push('--tag', tags.join(','));
    if (dtime != null) args.push('--dtime', String(dtime));

    try {
      execFileSync(binary, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    } catch (err) {
      throw new CommandExecutionError(`B站投稿失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    return [{
      status: dtime != null ? '✅ 定时投稿已提交' : '✅ 投稿成功',
      title,
      tid,
    }];
  },
});

cli({
  site: 'bilibili',
  name: 'biliup-login',
  access: 'write',
  description: 'B站 biliup 扫码登录，生成投稿用 cookie（一次性）',
  browser: false,
  strategy: Strategy.LOCAL,
  args: [
    { name: 'account', default: 'default', help: 'biliup 账号名（cookie 存 ~/.publishport/bilibili/<account>.json）' },
    { name: 'cookie', default: '', help: '直接指定 cookie 输出路径（覆盖 --account）' },
  ],
  columns: ['status', 'cookie'],
  func: async (kwargs) => {
    const cookiePath = resolveCookiePath(kwargs);
    fs.mkdirSync(path.dirname(cookiePath), { recursive: true });
    const binary = await ensureBiliupBinary(false);
    try {
      // biliup prints a login QR to the terminal; inherit stdio so the user can scan.
      execFileSync(binary, ['-u', cookiePath, 'login'], { stdio: 'inherit' });
    } catch (err) {
      throw new CommandExecutionError(`B站登录失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!fs.existsSync(cookiePath)) {
      throw new CommandExecutionError('登录流程结束但未生成 cookie 文件，请重试');
    }
    return [{ status: '✅ 登录成功', cookie: cookiePath }];
  },
});
