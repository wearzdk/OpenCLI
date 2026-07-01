// [pp-only] 机器级浏览器会话串行锁。
//
// PublishPort 的后台自动化窗口物理上一次只能安全服务一条命令：多条命令并发驱动同一个
// 窗口时，官方扩展的 rebind/关窗逻辑会把正在跑的命令的调试器扯掉（表现为
// `Debugger is not attached` / `Detached while handling command`），还会 race 出多余窗口。
// 由于并发的浏览器命令是各自独立的 opencli 进程，进程内的锁不够，必须跨进程串行。
//
// 这里用一个 O_EXCL 锁文件做机器级互斥：并发命令排队，一条条跑完，复用同一个窗口，
// 既不 churn 也不互相拆台。顺序命令锁立即可得、无影响。
//
// 稳定性要点（针对历史上「陈旧锁导致持续 DEVICE_BUSY」的坑）：
//  - 锁文件写入持有者 PID；等待方发现持有者进程已死（process.kill(pid,0) 抛 ESRCH）
//    立即抢占，不会被崩溃残留的锁永久卡死；
//  - 再加一层 mtime 兜底：锁文件过老（默认 10min）也视为陈旧，防 PID 复用的极端情况；
//  - 进程正常退出 finally 删锁；异常退出靠上面两层兜底自愈。

import { openSync, closeSync, writeSync, readFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOCK_DIR = join(homedir(), '.opencli');
const LOCK_PATH = join(LOCK_DIR, 'browser-adapter-session.lock');

// 等待前面排队命令的最长时间。设得比单条浏览器命令的运行上限更宽，好让后面的命令
// 排到队即可，而不是提前放弃。持有者若卡死，会先命中它自己命令的超时而释放锁。
const ACQUIRE_TIMEOUT_MS = 180_000;
// mtime 兜底：锁文件比这更老就视为陈旧可抢（正常命令远到不了这个量级）。
const STALE_AFTER_MS = 10 * 60_000;
const POLL_MS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = 进程不存在；EPERM = 存在但无权限发信号（仍算活着）。
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function readLockPid(): number | null {
  try {
    const pid = parseInt(readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** 原子占锁：O_EXCL 创建成功即获得锁。已存在返回 false（不抛）。 */
function tryAcquire(): boolean {
  try {
    const fd = openSync(LOCK_PATH, 'wx');
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw err;
  }
}

/** 持有者已死 / 锁文件过老 → 删掉陈旧锁，让后续 tryAcquire 抢占。 */
function reapStaleLock(): void {
  try {
    const pid = readLockPid();
    const age = Date.now() - statSync(LOCK_PATH).mtimeMs;
    if ((pid !== null && !isAlive(pid)) || age > STALE_AFTER_MS) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    // 锁文件刚被别人释放/删除：忽略，下一轮 tryAcquire 会重试。
  }
}

/**
 * 在机器级浏览器会话锁的保护下执行 fn。并发调用会排队串行；顺序调用无等待。
 * fn 抛出会原样冒泡，锁始终在 finally 里释放。
 */
export async function withBrowserSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  try {
    mkdirSync(LOCK_DIR, { recursive: true });
  } catch {
    // 目录已存在或无法创建（后者会在 openSync 时暴露真实错误）。
  }

  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  while (!tryAcquire()) {
    reapStaleLock();
    if (tryAcquire()) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `browser session lock busy: waited ${Math.round(ACQUIRE_TIMEOUT_MS / 1000)}s for another browser command to finish`,
      );
    }
    await sleep(POLL_MS);
  }

  try {
    return await fn();
  } finally {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      // 已被陈旧抢占逻辑删除或从未创建：无所谓。
    }
  }
}

/** 条件加锁：locked 为真时走串行锁，否则直接执行（前台/交互命令用独立窗口，无需串行）。 */
export async function withBrowserSessionLockIf<T>(locked: boolean, fn: () => Promise<T>): Promise<T> {
  return locked ? withBrowserSessionLock(fn) : fn();
}

// 供测试用的常量导出。
export const __lockInternals = { LOCK_PATH, ACQUIRE_TIMEOUT_MS, STALE_AFTER_MS };
