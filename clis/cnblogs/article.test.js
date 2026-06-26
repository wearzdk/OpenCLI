// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cnblogsProfile, cnblogsAuthProfile } from './article.js';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';

// ── 辅助：在 jsdom 里 eval 页面内代码，stub 全局 fetch ──────────────────────
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

// ── profile 基本结构 ──────────────────────────────────────────────────────────
describe('cnblogsProfile 结构校验', () => {
    it('home 指向博客园写作页', () => {
        expect(cnblogsProfile.home).toBe('https://i.cnblogs.com/posts/edit');
    });
    it('outputFormat 为 markdown', () => {
        expect(cnblogsProfile.outputFormat).toBe('markdown');
    });
    it('image.uploadFn 是函数（multipart 上传模式）', () => {
        expect(typeof cnblogsProfile.image.uploadFn).toBe('function');
    });
    it('image.skip 包含 cnblogs.com（本平台图不重传）', () => {
        expect(cnblogsProfile.image.skip).toContain('cnblogs.com');
    });
    it('publish 是函数', () => {
        expect(typeof cnblogsProfile.publish).toBe('function');
    });
});

// ── checkAuth：登录/未登录解析 ───────────────────────────────────────────────
describe('cnblogsAuthProfile.checkAuth', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('已登录：解析用户名和头像', async () => {
        // 模拟博客园 CurrentUserInfo 返回的 HTML 片段
        const mockHtml = `
            <a href="/u/testuser/"><img class="pfs" src="https://pic.cnblogs.com/avatar/test.png"></a>
        `;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => mockHtml,
        });

        const js = buildCheckAuthJs(cnblogsAuthProfile.checkAuth.toString());
        // eslint-disable-next-line no-eval
        const result = await (0, eval)(js);

        expect(result.isAuthenticated).toBe(true);
        expect(result.userId).toBe('testuser');
        expect(result.username).toBe('testuser');
        expect(result.avatar).toBe('https://pic.cnblogs.com/avatar/test.png');
    });

    it('未登录：HTML 中无 /u/xxx/ 链接', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => '<html><body>请登录</body></html>',
        });

        const js = buildCheckAuthJs(cnblogsAuthProfile.checkAuth.toString());
        // eslint-disable-next-line no-eval
        const result = await (0, eval)(js);

        expect(result.isAuthenticated).toBe(false);
    });

    it('网络错误：返回 isAuthenticated:false 并带 error', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('网络超时'));

        const js = buildCheckAuthJs(cnblogsAuthProfile.checkAuth.toString());
        // eslint-disable-next-line no-eval
        const result = await (0, eval)(js);

        expect(result.isAuthenticated).toBe(false);
        expect(result.error).toMatch(/网络超时/);
    });
});

// ── publish：草稿路径 ─────────────────────────────────────────────────────────
describe('cnblogsProfile.publish（草稿模式）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__cnblogsPublished; });

    it('草稿：POST /api/posts，返回 draft=true 和草稿 URL', async () => {
        // 设置 cookie（jsdom 允许写 document.cookie）
        document.cookie = 'XSRF-TOKEN=test-xsrf-value';

        let capturedBody = null;
        let capturedHeaders = null;

        const fetchImpl = vi.fn(async (url, opts) => {
            if (url === 'https://i.cnblogs.com/api/posts') {
                capturedBody = JSON.parse(opts.body);
                capturedHeaders = opts.headers;
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ id: 12345, blogId: 999 }),
                };
            }
            return { ok: true, status: 200, text: async () => '{}' };
        });

        const ctx = {
            title: '测试文章',
            content: '# 博客园测试\n\n正文内容',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: cnblogsProfile.image.skip,
        };
        const js = buildPublishJs(ctx, cnblogsProfile.publish.toString(), cnblogsProfile.image.uploadFn.toString());

        const p = (0, eval)(js.replace(/globalThis\.fetch/g, 'fetch'));
        // 用真实异步跑完
        globalThis.fetch = fetchImpl;
        // eslint-disable-next-line no-eval
        const result = await (async () => {
            const pf = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            try { return await (0, eval)(js); } finally { globalThis.fetch = pf; }
        })();

        expect(result.ok).toBe(true);
        expect(result.draft).toBe(true);
        expect(result.id).toBe('12345');
        expect(result.url).toContain('12345');

        // 验证 POST 请求结构
        expect(capturedBody.title).toBe('测试文章');
        expect(capturedBody.isMarkdown).toBe(true);
        expect(capturedBody.isDraft).toBe(true);
        expect(capturedBody.postBody).toBe('# 博客园测试\n\n正文内容');
        expect(capturedHeaders['x-xsrf-token']).toBe('test-xsrf-value');
        expect(capturedHeaders['Content-Type']).toBe('application/json');
    });

    it('缺少 XSRF-TOKEN cookie 时返回 auth 错误', async () => {
        // 清除 cookie
        document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT';

        const fetchImpl = vi.fn();
        const ctx = {
            title: '测试',
            content: '正文',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, cnblogsProfile.publish.toString(), cnblogsProfile.image.uploadFn.toString());

        const result = await (async () => {
            const pf = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            try { return await (0, eval)(js); } finally { globalThis.fetch = pf; }
        })();

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('auth');
    });
});

// ── publish：发布路径（非草稿）─────────────────────────────────────────────────
describe('cnblogsProfile.publish（发布模式）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('非草稿：先 POST 创建，再 PATCH 发布', async () => {
        document.cookie = 'XSRF-TOKEN=publish-xsrf';

        const calls = [];
        const fetchImpl = vi.fn(async (url, opts) => {
            calls.push({ url, method: opts && opts.method });
            if (url === 'https://i.cnblogs.com/api/posts') {
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ id: 99999, blogId: 1 }),
                };
            }
            if (url === 'https://i.cnblogs.com/api/posts/99999') {
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ url: 'https://www.cnblogs.com/testuser/p/99999.html' }),
                };
            }
            return { ok: true, status: 200, text: async () => '{}' };
        });

        const ctx = {
            title: '正式发布测试',
            content: '正文',
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: cnblogsProfile.image.skip,
        };
        const js = buildPublishJs(ctx, cnblogsProfile.publish.toString(), cnblogsProfile.image.uploadFn.toString());

        const result = await (async () => {
            const pf = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            try { return await (0, eval)(js); } finally { globalThis.fetch = pf; }
        })();

        expect(result.ok).toBe(true);
        expect(result.draft).toBe(false);
        expect(result.id).toBe('99999');
        expect(result.url).toContain('99999');

        // 验证两步请求顺序
        const apiCalls = calls.filter(c => c.url.includes('cnblogs.com'));
        expect(apiCalls[0].url).toBe('https://i.cnblogs.com/api/posts');
        expect(apiCalls[0].method).toBe('POST');
        expect(apiCalls[1].url).toBe('https://i.cnblogs.com/api/posts/99999');
        expect(apiCalls[1].method).toBe('PATCH');
    });

    it('创建草稿失败时返回 create 错误', async () => {
        document.cookie = 'XSRF-TOKEN=err-xsrf';

        const fetchImpl = vi.fn(async (url) => {
            if (url === 'https://i.cnblogs.com/api/posts') {
                return {
                    ok: false,
                    status: 403,
                    text: async () => '{"error":"Forbidden"}',
                };
            }
            return { ok: true, status: 200, text: async () => '{}' };
        });

        const ctx = {
            title: '失败测试',
            content: '正文',
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, cnblogsProfile.publish.toString(), cnblogsProfile.image.uploadFn.toString());

        const result = await (async () => {
            const pf = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            try { return await (0, eval)(js); } finally { globalThis.fetch = pf; }
        })();

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('create');
        expect(result.status).toBe(403);
    });
});

// ── 图片转存：uploadFn 路径 ───────────────────────────────────────────────────
describe('cnblogsProfile.image.uploadFn（图片转存）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('markdown 正文中外链图片被转存，src 被替换', async () => {
        document.cookie = 'XSRF-TOKEN=img-xsrf';

        const fetchImpl = vi.fn(async (url) => {
            // 下载外链图片
            if (url === 'https://external.com/photo.jpg') {
                return { ok: true, blob: async () => new Blob(['img'], { type: 'image/jpeg' }) };
            }
            // 上传到博客园图床
            if (url === 'https://upload.cnblogs.com/v2/images/cors-upload') {
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ data: 'https://img2024.cnblogs.com/blog/1/202401/1-abc.png' }),
                };
            }
            // 发布 API
            if (url === 'https://i.cnblogs.com/api/posts') {
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ id: 777, blogId: 1 }),
                };
            }
            return { ok: true, status: 200, text: async () => '{}' };
        });

        const ctx = {
            title: '图片测试',
            content: '正文\n\n![图片](https://external.com/photo.jpg)\n\n结尾',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: cnblogsProfile.image.skip,
        };
        const js = buildPublishJs(ctx, cnblogsProfile.publish.toString(), cnblogsProfile.image.uploadFn.toString());

        let capturedPublishContent = null;
        // 在 publish 函数前插入捕获
        const captureJs = js.replace(
            'const __pub = await __publish(',
            'capturedPublishContent = content; const __pub = await __publish(',
        );

        // processImagesWith 内部有 setTimeout 节流（300ms），需要 runAllTimersAsync 推进
        const execP = (async () => {
            const pf = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            try { return await (0, eval)(captureJs); } finally { globalThis.fetch = pf; }
        })();
        await vi.runAllTimersAsync();
        const result = await execP;

        // 验证图片 URL 被替换
        if (capturedPublishContent !== null) {
            expect(capturedPublishContent).toContain('img2024.cnblogs.com');
            expect(capturedPublishContent).not.toContain('external.com');
        }
        expect(result.ok).toBe(true);
        // 本平台图片（cnblogs.com）不重传
        expect(cnblogsProfile.image.skip.some(p => 'img2024.cnblogs.com'.includes(p))).toBe(true);
    });
});
