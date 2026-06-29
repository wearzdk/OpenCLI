import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal()),
    spawnSync: mockSpawnSync,
}));

import { getRegistry } from '@jackwener/opencli/registry';
import './upload.js';
import { buildBiliupCredential } from './upload.js';

const command = getRegistry().get('bilibili/upload');

// A real temp video file so the existsSync guard passes.
const tmpVideo = path.join(os.tmpdir(), `pp-upload-test-${process.pid}.mp4`);
fs.writeFileSync(tmpVideo, 'fake');
afterAll(() => fs.rmSync(tmpVideo, { force: true }));

const validCookies = [
    { name: 'SESSDATA', value: 'sess-xxx' },
    { name: 'bili_jct', value: 'jct-yyy' },
    { name: 'DedeUserID', value: '12345' },
    { name: 'b_nut', value: 'noise' },
];
const pageWith = (cookies) => ({ getCookies: vi.fn(async () => cookies) });

beforeEach(() => mockSpawnSync.mockReset());

describe('buildBiliupCredential', () => {
    it('maps browser cookies into biliup cookies.json schema', () => {
        const cred = buildBiliupCredential(validCookies);
        expect(cred.cookie_info.cookies).toContainEqual({ name: 'SESSDATA', value: 'sess-xxx' });
        expect(cred.cookie_info.cookies).toContainEqual({ name: 'bili_jct', value: 'jct-yyy' });
        expect(cred.token_info.mid).toBe(12345);
        expect(cred.platform).toBe('web');
    });

    it('throws AuthRequiredError when a required cookie is missing', () => {
        expect(() => buildBiliupCredential([{ name: 'SESSDATA', value: 'x' }])).toThrow(AuthRequiredError);
    });
});

describe('bilibili upload', () => {
    it('refuses to upload without --execute (dry-run), never spawning biliup', async () => {
        const out = await command.func(pageWith(validCookies), { file: tmpVideo, tag: 'a,b' });
        expect(out.status).toBe('dry-run');
        expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it('requires at least one tag', async () => {
        await expect(command.func(pageWith(validCookies), { file: tmpVideo, tag: '  ' })).rejects.toThrow(
            ArgumentError,
        );
    });

    it('rejects a non-existent video file', async () => {
        await expect(command.func(pageWith(validCookies), { file: '/no/such.mp4', tag: 'a' })).rejects.toThrow(
            /不存在/,
        );
    });

    it('surfaces a not-logged-in browser as AuthRequiredError', async () => {
        await expect(command.func(pageWith([]), { file: tmpVideo, tag: 'a', execute: true })).rejects.toThrow(
            AuthRequiredError,
        );
    });

    it('shells out to biliup with mapped flags on --execute', async () => {
        mockSpawnSync.mockReturnValue({ status: 0, stdout: 'BV1abc done', stderr: '' });
        const out = await command.func(pageWith(validCookies), {
            file: tmpVideo,
            tag: 'tech, ai',
            title: 'Hello',
            tid: 201,
            desc: 'd',
            execute: true,
        });
        expect(out.status).toBe('uploaded');
        const [bin, args] = mockSpawnSync.mock.calls[0];
        expect(bin).toBe('biliup');
        expect(args).toContain('upload');
        expect(args).toContain(tmpVideo);
        expect(args).toEqual(expect.arrayContaining(['--title', 'Hello', '--tag', 'tech,ai', '--tid', '201']));
    });

    it('maps a non-zero biliup exit into CommandExecutionError', async () => {
        mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });
        await expect(
            command.func(pageWith(validCookies), { file: tmpVideo, tag: 'a', execute: true }),
        ).rejects.toThrow(CommandExecutionError);
    });

    it('reports a missing biliup binary clearly', async () => {
        mockSpawnSync.mockReturnValue({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) });
        await expect(
            command.func(pageWith(validCookies), { file: tmpVideo, tag: 'a', execute: true }),
        ).rejects.toThrow(/biliup 二进制/);
    });
});
