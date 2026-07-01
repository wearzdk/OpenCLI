/**
 * CLI commands for daemon lifecycle:
 *   opencli daemon status — show daemon state
 *   opencli daemon stop   — graceful shutdown
 *   opencli daemon restart — graceful shutdown, then start a fresh daemon
 *   opencli daemon warm — [pp-only] 预热后台自动化窗口（挂一个持久空白标签）
 */

import { fetchDaemonStatus, requestDaemonShutdown } from '../browser/daemon-client.js';
import { restartDaemon } from '../browser/daemon-lifecycle.js';
import { formatDuration } from '../download/progress.js';
import { log } from '../logger.js';
import { PKG_VERSION } from '../version.js';
import { formatDaemonVersion, isDaemonStale } from '../browser/daemon-version.js';
import { browserSession, getBrowserFactory } from '../runtime.js';

export async function daemonStatus(): Promise<void> {
  const status = await fetchDaemonStatus();
  if (!status) {
    console.log('Daemon: not running');
    return;
  }

  // GH #1575: ``Extension: disconnected`` used to be printed for THREE
  // structurally different states — zero profiles (accurate), 2+
  // profiles connected with no default (misleading), and a requested
  // profile that vanished (misleading). The status JSON already
  // distinguishes them; surface that distinction so the user's next
  // step is visible inline instead of "reinstall everything".
  let extensionLabel: string;
  if (status.extensionConnected) {
    extensionLabel = status.extensionVersion
      ? `connected (v${status.extensionVersion})`
      : 'connected (version unknown)';
  } else if (status.profileRequired) {
    const count = status.profiles?.length ?? 0;
    extensionLabel = `${count} ${count === 1 ? 'profile' : 'profiles'} connected, none selected — run \`opencli profile use <name>\``;
  } else if (status.profileDisconnected) {
    extensionLabel = 'requested profile not connected — run `opencli profile use <name>`';
  } else {
    extensionLabel = 'disconnected';
  }

  const daemonVersion = formatDaemonVersion(status);
  const stale = isDaemonStale(status, PKG_VERSION);
  console.log(`Daemon: ${stale ? 'stale' : 'running'} (PID ${status.pid})`);
  console.log(`Version: ${daemonVersion}${stale ? ` (CLI v${PKG_VERSION}; run: opencli daemon restart)` : ''}`);
  console.log(`Uptime: ${formatDuration(Math.round(status.uptime * 1000))}`);
  console.log(`Extension: ${extensionLabel}`);
  if (status.profiles && status.profiles.length > 0) {
    console.log(`Profiles: ${status.profiles.map((profile) => {
      const version = profile.extensionVersion ? ` v${profile.extensionVersion}` : '';
      return `${profile.contextId}${version}`;
    }).join(', ')}`);
  }
  console.log(`Memory: ${status.memoryMB} MB`);
  console.log(`Port: ${status.port}`);
}

export async function daemonStop(): Promise<void> {
  const status = await fetchDaemonStatus();
  if (!status) {
    log.info('Daemon is not running.');
    return;
  }

  const ok = await requestDaemonShutdown();
  if (ok) {
    log.success('Daemon stopped.');
  } else {
    log.error('Failed to stop daemon.');
    process.exitCode = 1;
  }
}

export async function daemonRestart(): Promise<void> {
  const before = await fetchDaemonStatus();
  if (before?.profiles && before.profiles.length > 0) {
    log.warn(`Restarting daemon will disconnect ${before.profiles.length} browser profile(s); the extension should reconnect automatically.`);
  }

  const result = await restartDaemon();
  if (!result.stopped) {
    log.error('Failed to stop daemon before restart.');
    process.exitCode = 1;
    return;
  }
  if (!result.status) {
    log.error('Daemon restart timed out before the new daemon reported status.');
    process.exitCode = 1;
    return;
  }

  const action = result.previousStatus ? 'restarted' : 'started';
  const version = formatDaemonVersion(result.status);
  log.success(`Daemon ${action} on port ${result.status.port} (${version}).`);
  if (result.status.extensionConnected) {
    const profiles = result.status.profiles?.length ?? 0;
    const profileText = profiles > 0 ? `; profiles connected: ${profiles}` : '';
    log.status(`Extension connected${profileText}.`);
  } else {
    log.warn('Daemon is running, but the Browser Bridge extension has not connected yet.');
  }
}

/**
 * [pp-only] 预热后台自动化窗口。
 *
 * 用一个持久（persistent）会话在后台打开自动化窗口并挂一个标签，让「后台常驻窗口」在
 * **任何真实命令之前**就已经存在——之后各平台命令只是往这个窗口里加/复用标签，永远不会
 * 「一有动作就弹一个新窗口」。桌面客户端在启动、且检测到扩展已连接后调用一次即可。
 *
 * `url` 传一个说明页（如 https://publishport.app/automation）时，这个常驻标签会停在
 * 说明页上，告诉用户「此窗口用于自动化、请勿关闭」——用户不关它，Chrome 与扩展就一直
 * 在线，PublishPort 也能稳定检测到浏览器。不传则回退到 about:blank。
 *
 * 窗口走 background 模式（不聚焦、不抢焦点），标签因 persistent 永不 idle 关闭，会一直
 * 挂着。重复调用是幂等的（复用同一个已存在的窗口/标签）。
 */
export async function daemonWarm(url?: string): Promise<void> {
  const status = await fetchDaemonStatus();
  if (!status) {
    // 没连上扩展时 browserSession 会自行拉起 daemon 并等待；但扩展没连上就没法建窗，
    // 这里只提示、不报错，交由桌面在扩展就绪后重试。
    log.warn('Daemon/extension not ready; skip warm (retry after the browser extension connects).');
    return;
  }
  if (!status.extensionConnected) {
    log.warn('Browser extension not connected yet; skip warm.');
    return;
  }
  // 扩展只放行 http/https 导航；其它一律回退 about:blank，避免报错。
  const target = url && /^https?:\/\//i.test(url) ? url : 'about:blank';
  const BrowserFactory = getBrowserFactory('__warm__');
  try {
    await browserSession(
      BrowserFactory,
      async (page) => {
        // 一次导航即可强制扩展创建自动化窗口 + 标签并登记 persistent 租约。
        await page.goto(target).catch(() => {});
      },
      { session: 'site:__warm__', windowMode: 'background', surface: 'adapter', siteSession: 'persistent' },
    );
    log.success(`Automation window warmed (${target}, kept alive for reuse).`);
  } catch (err) {
    log.warn(`Warm failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
