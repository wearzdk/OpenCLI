import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgumentError, AuthRequiredError } from '@jackwener/opencli/errors';

import { getRegistry } from '@jackwener/opencli/registry';
import './upload.js';

const command = getRegistry().get('bilibili/upload');

// 真实临时视频文件，让 resolveVideoFile 的 existsSync/扩展名校验通过。
const tmpVideo = path.join(os.tmpdir(), `pp-upload-test-${process.pid}.mp4`);
fs.writeFileSync(tmpVideo, 'fake-bytes');
afterAll(() => fs.rmSync(tmpVideo, { force: true }));

const LOGGED_IN = [
  { name: 'SESSDATA', value: 'sess-xxx' },
  { name: 'bili_jct', value: 'jct-yyy' },
  { name: 'DedeUserID', value: '243892009' },
  { name: 'buvid3', value: 'noise' },
];

// 模拟一个已登录、停留在 member.bilibili.com 的 page。dry-run 路径只用到 goto/wait/evaluate/getCookies。
function mockPage(cookies = LOGGED_IN) {
  return {
    goto: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    evaluate: vi.fn(async (js) => {
      if (typeof js === 'string' && js.includes('location.href')) return 'https://member.bilibili.com/platform/home';
      return undefined;
    }),
    getCookies: vi.fn(async () => cookies),
  };
}

describe('bilibili upload —— 参数校验', () => {
  it('requires at least one tag', async () => {
    await expect(command.func(mockPage(), { file: tmpVideo, tid: 21, tag: '  ' })).rejects.toThrow(ArgumentError);
  });

  it('requires a numeric --tid (no fallback)', async () => {
    await expect(command.func(mockPage(), { file: tmpVideo, tag: 'a' })).rejects.toThrow(/tid/);
  });

  it('rejects a non-existent video file', async () => {
    await expect(command.func(mockPage(), { file: '/no/such.mp4', tid: 21, tag: 'a' })).rejects.toThrow(/不存在/);
  });

  it('rejects copyright=2 without --source', async () => {
    await expect(
      command.func(mockPage(), { file: tmpVideo, tid: 21, tag: 'a', copyright: 2 }),
    ).rejects.toThrow(/转载/);
  });

  it('rejects an unknown upload line', async () => {
    await expect(
      command.func(mockPage(), { file: tmpVideo, tid: 21, tag: 'a', line: 'nope' }),
    ).rejects.toThrow(/线路/);
  });
});

describe('bilibili upload —— 登录态', () => {
  it('surfaces a not-logged-in browser as AuthRequiredError', async () => {
    await expect(
      command.func(mockPage([{ name: 'buvid3', value: 'x' }]), { file: tmpVideo, tid: 21, tag: 'a', execute: true }),
    ).rejects.toThrow(AuthRequiredError);
  });
});

describe('bilibili upload —— dry-run', () => {
  it('validates without --execute and never touches the upload pipeline', async () => {
    const page = mockPage();
    const out = await command.func(page, { file: tmpVideo, tid: 21, tag: 'tech, ai', title: 'Hello' });
    expect(out.status).toBe('dry-run');
    expect(out.title).toBe('Hello');
    // dry-run 不应注入运行时 / 启动上传。
    const evalCalls = page.evaluate.mock.calls.map((c) => String(c[0]));
    expect(evalCalls.some((s) => s.includes('startUpload'))).toBe(false);
    expect(evalCalls.some((s) => s.includes('__ppbili'))).toBe(false);
  });

  it('defaults the title to the file basename', async () => {
    const out = await command.func(mockPage(), { file: tmpVideo, tid: 21, tag: 'a' });
    expect(out.status).toBe('dry-run');
    expect(out.title).toBe(path.basename(tmpVideo).replace(/\.[^.]+$/, ''));
  });
});
