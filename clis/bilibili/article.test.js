// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { bilibiliArticleProfile } from './article.js';
import { buildPublishJs } from '../_shared/article/publish.js';
import { evalPageRuntime } from '../_shared/article/page-runtime.js';

// ── 辅助：在 jsdom 里跑单次 evaluate（模拟 page.evaluate）──────────────────

function makeEvalPage(fetchImpl) {
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

// ── 辅助：直接在 jsdom 里跑 profile.publish / profile.uploadFn ─────────────

async function runInPage(fn, fetchImpl, cookieOverride) {
    if (cookieOverride != null) {
        Object.defineProperty(document, 'cookie', {
            configurable: true,
            get: () => cookieOverride,
            set: () => {},
        });
    }
    const pf = globalThis.fetch;
    globalThis.fetch = fetchImpl || vi.fn();
    try {
        const PP = evalPageRuntime();
        return await fn(PP);
    } finally {
        globalThis.fetch = pf;
        if (cookieOverride != null) {
            // 还原 cookie 描述符，避免污染其他测试
            Object.defineProperty(document, 'cookie', {
                configurable: true,
                writable: true,
                value: '',
            });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('bilibiliArticleProfile 基本属性', () => {
    it('outputFormat 为 html', () => {
        expect(bilibiliArticleProfile.outputFormat).toBe('html');
    });
    it('preprocessConfig 包含 removeLinks:true', () => {
        expect(bilibiliArticleProfile.preprocessConfig).toBeDefined();
        expect(bilibiliArticleProfile.preprocessConfig.removeLinks).toBe(true);
    });
    it('image.skip 包含 B站 CDN 域名', () => {
        const skip = bilibiliArticleProfile.image.skip;
        expect(skip).toContain('hdslb.com');
        expect(skip).toContain('bilibili.com');
        expect(skip).toContain('biliimg.com');
    });
    it('image.uploadFn 是函数', () => {
        expect(typeof bilibiliArticleProfile.image.uploadFn).toBe('function');
    });
    it('publish 是函数', () => {
        expect(typeof bilibiliArticleProfile.publish).toBe('function');
    });
    it('home 指向创作中心专栏页', () => {
        expect(bilibiliArticleProfile.home).toContain('member.bilibili.com');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('profile.publish — 草稿保存成功路径', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('草稿保存成功，返回 ok:true、draft:true 以及 url', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 0, data: { aid: 12345 } }),
        });

        const I = { title: '测试标题', content: '<p>正文</p>', draftOnly: false };

        const result = await runInPage(
            (PP) => bilibiliArticleProfile.publish(I, PP),
            mockFetch,
            'bili_jct=test_csrf_token; SESSDATA=abc123',
        );

        expect(result.ok).toBe(true);
        expect(result.draft).toBe(true);
        expect(result.id).toBe('12345');
        expect(result.url).toContain('aid=12345');
        expect(result.url).toContain('member.bilibili.com');
    });

    it('发出的请求携带正确的表单字段', async () => {
        let capturedBody = null;
        const mockFetch = vi.fn().mockImplementation(async (url, opts) => {
            capturedBody = opts?.body;
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ code: 0, data: { aid: 99 } }),
            };
        });

        const I = { title: '我的标题', content: '<h1>内容</h1>', draftOnly: true };

        await runInPage(
            (PP) => bilibiliArticleProfile.publish(I, PP),
            mockFetch,
            'bili_jct=csrf123',
        );

        expect(mockFetch).toHaveBeenCalled();
        const callArgs = mockFetch.mock.calls[0];
        // URL 应包含草稿 API
        expect(callArgs[0]).toContain('draft/addupdate');
        // body 是 URLSearchParams 字符串
        const bodyStr = capturedBody instanceof URLSearchParams
            ? capturedBody.toString()
            : String(capturedBody);
        expect(bodyStr).toContain('title=');
        expect(bodyStr).toContain('csrf=csrf123');
        expect(bodyStr).toContain('tid=4');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('profile.publish — 错误路径', () => {
    it('缺少 bili_jct cookie 时返回 ok:false', async () => {
        const mockFetch = vi.fn();
        const I = { title: '标题', content: '<p>x</p>', draftOnly: false };

        const result = await runInPage(
            (PP) => bilibiliArticleProfile.publish(I, PP),
            mockFetch,
            '',   // 空 cookie，没有 bili_jct
        );

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/bili_jct/);
        // 无 CSRF 不应发任何请求
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('API 返回非零 code 时返回 ok:false', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: -101, message: '账号未登录' }),
        });

        const I = { title: '标题', content: '<p>x</p>', draftOnly: false };

        const result = await runInPage(
            (PP) => bilibiliArticleProfile.publish(I, PP),
            mockFetch,
            'bili_jct=tok',
        );

        expect(result.ok).toBe(false);
        expect(result.message).toContain('账号未登录');
    });

    it('HTTP 非 200 时返回 ok:false', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: async () => 'Forbidden',
        });

        const I = { title: '标题', content: '<p>x</p>', draftOnly: false };

        const result = await runInPage(
            (PP) => bilibiliArticleProfile.publish(I, PP),
            mockFetch,
            'bili_jct=tok',
        );

        expect(result.ok).toBe(false);
        expect(result.status).toBe(403);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('image.uploadFn — 图片转存', () => {
    it('正确下载图片字节并 multipart 上传，返回新 URL', async () => {
        const mockFetch = vi.fn()
            // 第一次调用：下载原图（credentials:omit）
            .mockResolvedValueOnce({
                ok: true,
                blob: async () => new Blob(['fake-image-bytes'], { type: 'image/jpeg' }),
            })
            // 第二次调用：上传到 B站
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ code: 0, data: { url: 'https://i0.hdslb.com/bfs/article/new.jpg', size: 1024 } }),
            });

        const result = await runInPage(
            (PP) => bilibiliArticleProfile.image.uploadFn('https://example.com/img.jpg', PP),
            mockFetch,
            'bili_jct=csrf_token',
        );

        expect(result.url).toBe('https://i0.hdslb.com/bfs/article/new.jpg');
        // 下载用 omit，上传用 include
        expect(mockFetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
        expect(mockFetch.mock.calls[1][1]).toMatchObject({ credentials: 'include' });
        // 上传 URL 应包含 upcover
        expect(mockFetch.mock.calls[1][0]).toContain('upcover');
    });

    it('缺少 CSRF token 时抛错', async () => {
        const mockFetch = vi.fn();

        await expect(
            runInPage(
                (PP) => bilibiliArticleProfile.image.uploadFn('https://example.com/img.jpg', PP),
                mockFetch,
                '',  // 空 cookie
            ),
        ).rejects.toThrow(/bili_jct/);
    });

    it('上传接口返回 code 非 0 时抛错', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                blob: async () => new Blob(['bytes'], { type: 'image/png' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ code: -400, message: '图片格式不支持' }),
            });

        await expect(
            runInPage(
                (PP) => bilibiliArticleProfile.image.uploadFn('https://example.com/img.png', PP),
                mockFetch,
                'bili_jct=tok',
            ),
        ).rejects.toThrow(/图片格式不支持/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('buildPublishJs — B站专栏管线拼装', () => {
    it('拼出的 JS 包含 PAGE_RUNTIME、uploadFn 分支和 processImagesWith', () => {
        const uploadFnSource = bilibiliArticleProfile.image.uploadFn.toString();
        const publishFnSource = bilibiliArticleProfile.publish.toString();
        const ctx = {
            title: '标题',
            content: '<p>x</p>',
            draftOnly: false,
            outputFormat: 'html',
            preprocessConfig: bilibiliArticleProfile.preprocessConfig,
            imageSpec: null,
            imageSkip: bilibiliArticleProfile.image.skip,
        };
        const js = buildPublishJs(ctx, publishFnSource, uploadFnSource);
        expect(js).toContain('var PP = ');            // 注入页面运行时
        expect(js).toContain('PP.preprocess(content');  // html 平台预处理
        expect(js).toContain('processImagesWith');     // 使用 uploadFn 转存
        expect(js).toContain('__upload');              // 自定义上传函数
        expect(js).toContain('__publish(');            // 调发布函数
    });
});
