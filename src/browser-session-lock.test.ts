import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { withBrowserSessionLock, withBrowserSessionLockIf, __lockInternals } from './browser-session-lock.js';

const LOCK = __lockInternals.LOCK_PATH;

function cleanupLock() {
  try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch { /* ignore */ }
}

describe('browser-session-lock', () => {
  afterEach(cleanupLock);

  it('serializes concurrent holders — no overlap', async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const task = (id: string) => withBrowserSessionLock(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push(`enter:${id}`);
      await new Promise((r) => setTimeout(r, 30));
      events.push(`exit:${id}`);
      active--;
    });

    await Promise.all([task('a'), task('b'), task('c')]);

    // 任一时刻只有一个持有者 → 临界区不重叠。
    expect(maxActive).toBe(1);
    // enter/exit 必须严格配对相邻（a 进 a 出、b 进 b 出…），不会交错。
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]).toMatch(/^enter:/);
      expect(events[i + 1]).toMatch(/^exit:/);
      expect(events[i].split(':')[1]).toBe(events[i + 1].split(':')[1]);
    }
    // 锁在最后被释放。
    expect(existsSync(LOCK)).toBe(false);
  });

  it('releases the lock even when the body throws', async () => {
    await expect(withBrowserSessionLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(LOCK)).toBe(false);
  });

  it('steals a stale lock whose owner PID is dead', async () => {
    // 写一个持有者 PID = 一个几乎不可能存在的进程号的锁文件（模拟崩溃残留）。
    writeFileSync(LOCK, '2147483646');
    let ran = false;
    await withBrowserSessionLock(async () => { ran = true; });
    expect(ran).toBe(true);
    expect(existsSync(LOCK)).toBe(false);
  });

  it('withBrowserSessionLockIf(false) runs without touching the lock file', async () => {
    let ran = false;
    await withBrowserSessionLockIf(false, async () => {
      ran = true;
      // 未加锁：临界区内锁文件不应存在。
      expect(existsSync(LOCK)).toBe(false);
    });
    expect(ran).toBe(true);
  });

  it('withBrowserSessionLockIf(true) does acquire the lock', async () => {
    let sawLock = false;
    await withBrowserSessionLockIf(true, async () => {
      sawLock = existsSync(LOCK);
    });
    expect(sawLock).toBe(true);
    expect(existsSync(LOCK)).toBe(false);
  });
});
