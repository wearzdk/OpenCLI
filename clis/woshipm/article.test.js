// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { woshipmProfile } from './article.js';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';

// ── 辅助：在 jsdom 里模拟一个带 stub fetch 的 page 句柄 ───────────────────────
function evalPage(fetchImpl) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: async (js) => {
            const pf = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            try {
                // eslint-disable-next-line no-eval
                return await (0, eval)(js);
            } finally {
                globalThis.fetch = pf;
            }
        },
    };
}

// ── profile 结构基本断言 ──────────────────────────────────────────────────────

describe('woshipmProfile 结构', () => {
    it('home 指向写作页', () => {
        expect(woshipmProfile.home).toBe('https://www.woshipm.com/writing');
    });
    it('outputFormat 为 html', () => {
        expect(woshipmProfile.outputFormat).toBe('html');
    });
    it('preprocessConfig 存在且包含 removeEmptyLines', () => {
        expect(woshipmProfile.preprocessConfig).toBeDefined();
        expect(woshipmProfile.preprocessConfig.removeEmptyLines).toBe(true);
    });
    it('image.skip 包含 woshipm.com 域名', () => {
        expect(woshipmProfile.image.skip).toContain('woshipm.com');
        expect(woshipmProfile.image.skip).toContain('image.woshipm.com');
    });
    it('image.uploadFn 是函数（自定义图片上传）', () => {
        expect(typeof woshipmProfile.image.uploadFn).toBe('function');
    });
    it('publish 是函数', () => {
        expect(typeof woshipmProfile.publish).toBe('function');
    });
    it('checkAuth 是函数', () => {
        expect(typeof woshipmProfile.checkAuth).toBe('function');
    });
});

// ── checkAuth：登录状态解析 ──────────────────────────────────────────────────

describe('checkAuth', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const makeFetch = (writing, profile) => vi.fn(async (url) => {
        if (url === 'https://www.woshipm.com/writing') {
            return {
                ok: true,
                status: 200,
                text: async () => writing,
            };
        }
        // profile API
        return {
            ok: true,
            status: 200,
            json: async () => profile,
        };
    });

    it('已登录：解析出 userId 和 username', async () => {
        const writingHtml = `
            <html><body>
            var userSettings = {"url":"/","uid":"1585","some":"val"};
            var config = {"jltoken":"test-token-abc"};
            </body></html>
        `;
        const profileData = {
            CODE: 200,
            RESULT: {
                userInfoVo: {
                    uid: 1585,
                    nickName: '张三产品',
                    avartar: 'https://img.woshipm.com/avatar.png',
                },
            },
        };
        const js = buildCheckAuthJs(woshipmProfile.checkAuth.toString());
        const page = evalPage(makeFetch(writingHtml, profileData));
        const r = await page.evaluate(js);
        expect(r.isAuthenticated).toBe(true);
        expect(r.userId).toBe('1585');
        expect(r.username).toBe('张三产品');
    });

    it('未登录（无 uid）：isAuthenticated=false', async () => {
        const writingHtml = `<html><body>页面无 userSettings</body></html>`;
        const js = buildCheckAuthJs(woshipmProfile.checkAuth.toString());
        const page = evalPage(makeFetch(writingHtml, {}));
        const r = await page.evaluate(js);
        expect(r.isAuthenticated).toBe(false);
    });

    it('profile API 返回非 200：isAuthenticated=false', async () => {
        const writingHtml = `
            <html><body>
            var userSettings = {"url":"/","uid":"999"};
            </body></html>
        `;
        const profileData = { CODE: 401, RESULT: null };
        const js = buildCheckAuthJs(woshipmProfile.checkAuth.toString());
        const page = evalPage(makeFetch(writingHtml, profileData));
        const r = await page.evaluate(js);
        expect(r.isAuthenticated).toBe(false);
    });
});

// ── publish：发布请求结构验证 ────────────────────────────────────────────────

describe('publish', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__lastPublishBody; });

    function makePublishFetch(postId, url) {
        return vi.fn(async (reqUrl, opts) => {
            if (reqUrl && String(reqUrl).includes('admin-ajax.php')) {
                // 记录发布请求 body 供断言
                globalThis.__lastPublishBody = opts && opts.body ? opts.body.toString() : '';
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ post_id: postId, url }),
                };
            }
            // 图片上传相关请求（不在此测试中触发，但防止 undefined）
            return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
        });
    }

    it('成功路径：调用 admin-ajax.php 建草稿，返回 ok:true 和 draftId', async () => {
        const ctx = {
            title: '产品设计方法论',
            content: '<p>正文内容</p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: woshipmProfile.preprocessConfig,
            imageSpec: null,
            imageSkip: woshipmProfile.image.skip,
        };
        const js = buildPublishJs(ctx, woshipmProfile.publish.toString(), woshipmProfile.image.uploadFn.toString());
        const page = evalPage(makePublishFetch('12345', 'https://www.woshipm.com/writing?pid=12345'));
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;
        expect(result.ok).toBe(true);
        expect(result.id).toBe('12345');
        expect(result.url).toBe('https://www.woshipm.com/writing?pid=12345');
        expect(result.draft).toBe(true);
    });

    it('创建草稿失败时返回 ok:false', async () => {
        const ctx = {
            title: '失败测试',
            content: '<p>内容</p>',
            draftOnly: false,
            outputFormat: 'html',
            preprocessConfig: woshipmProfile.preprocessConfig,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, woshipmProfile.publish.toString(), woshipmProfile.image.uploadFn.toString());
        const page = evalPage(vi.fn(async () => ({
            ok: false,
            status: 403,
            text: async () => JSON.stringify({ error: '无权限' }),
        })));
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;
        expect(result.ok).toBe(false);
        expect(result.stage).toBe('create');
        expect(result.status).toBe(403);
    });

    it('响应无 post_id 时返回 ok:false', async () => {
        const ctx = {
            title: '无 id 测试',
            content: '<p>内容</p>',
            draftOnly: false,
            outputFormat: 'html',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, woshipmProfile.publish.toString(), woshipmProfile.image.uploadFn.toString());
        const page = evalPage(vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ success: false, error: '标题已存在' }),
        })));
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/标题已存在/);
    });
});

// ── 图片上传函数：结构验证 ────────────────────────────────────────────────────

describe('image.uploadFn', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('下载图片后上传到 tensorflow/upyun/upload，返回新 URL', async () => {
        const newUrl = 'https://image.woshipm.com/wp-files/2024/01/test.png';
        const fetchImpl = vi.fn(async (url) => {
            if (url === 'https://external.com/photo.png') {
                // 模拟下载图片
                return { ok: true, status: 200, blob: async () => new Blob(['img'], { type: 'image/png' }) };
            }
            // 模拟上传接口
            return {
                ok: true,
                status: 200,
                json: async () => ({ data: [{ url: newUrl }] }),
            };
        });

        // 设置页面有 jltoken
        document.documentElement.innerHTML = `<html><body>{"jltoken":"my-token-xyz"}</body></html>`;

        const oldFetch = globalThis.fetch;
        globalThis.fetch = fetchImpl;
        try {
            const result = await woshipmProfile.image.uploadFn('https://external.com/photo.png', null);
            expect(result.url).toBe(newUrl);
            // 确认调用了上传接口
            const uploadCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('tensorflow/upyun/upload'));
            expect(uploadCall).toBeTruthy();
            // 确认携带了 jltoken header
            const uploadOpts = uploadCall[1];
            expect(uploadOpts.headers && uploadOpts.headers['jlstar']).toBe('Bearer my-token-xyz');
        } finally {
            globalThis.fetch = oldFetch;
        }
    });

    it('上传接口返回无 url 时抛错', async () => {
        document.documentElement.innerHTML = `<html><body>{"jltoken":"tok"}</body></html>`;
        const fetchImpl = vi.fn(async (url) => {
            if (url === 'https://bad.com/img.png') {
                return { ok: true, blob: async () => new Blob(['x']) };
            }
            return { ok: true, json: async () => ({ data: [] }) };
        });
        const oldFetch = globalThis.fetch;
        globalThis.fetch = fetchImpl;
        try {
            await expect(woshipmProfile.image.uploadFn('https://bad.com/img.png', null))
                .rejects.toThrow(/图片上传失败/);
        } finally {
            globalThis.fetch = oldFetch;
        }
    });
});
