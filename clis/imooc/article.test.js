// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { imoocProfile } from './article.js';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';

// ── 辅助：在 jsdom 里执行 page.evaluate 风格的 JS，stub 全局 fetch ────────────
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

// ── profile 基本字段 ──────────────────────────────────────────────────────────
describe('imoocProfile 字段校验', () => {
    it('outputFormat 为 markdown', () => {
        expect(imoocProfile.outputFormat).toBe('markdown');
    });
    it('home 指向慕课手记写作页', () => {
        expect(imoocProfile.home).toBe('https://www.imooc.com/article');
    });
    it('publish 是函数', () => {
        expect(typeof imoocProfile.publish).toBe('function');
    });
    it('checkAuth 是函数', () => {
        expect(typeof imoocProfile.checkAuth).toBe('function');
    });
    it('image.uploadFn 是函数（自定义上传）', () => {
        expect(typeof imoocProfile.image.uploadFn).toBe('function');
    });
    it('image.skip 包含慕课图床域名', () => {
        const skip = imoocProfile.image.skip || [];
        expect(skip.some((s) => s.includes('imooc.com'))).toBe(true);
    });
});

// ── checkAuth：已登录 ─────────────────────────────────────────────────────────
describe('checkAuth：已登录路径', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('JSONP 解析正确，返回 isAuthenticated true + 账号信息', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => 'jsonpcallback({"result":0,"data":{"uid":12345,"nickname":"测试用户","img":"https://img.imooc.com/avatar.jpg"}})',
        });
        const js = buildCheckAuthJs(imoocProfile.checkAuth.toString());
        const page = evalPage(mockFetch);
        const result = await page.evaluate(js);

        expect(result.isAuthenticated).toBe(true);
        expect(result.userId).toBe('12345');
        expect(result.username).toBe('测试用户');
    });
});

// ── checkAuth：未登录 ─────────────────────────────────────────────────────────
describe('checkAuth：未登录路径', () => {
    it('result !== 0 时返回 isAuthenticated false', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => 'jsonpcallback({"result":-1,"msg":"请先登录"})',
        });
        const js = buildCheckAuthJs(imoocProfile.checkAuth.toString());
        const page = evalPage(mockFetch);
        const result = await page.evaluate(js);

        expect(result.isAuthenticated).toBe(false);
        expect(result.error).toContain('请先登录');
    });

    it('返回非法 JSON 时返回 isAuthenticated false 并带 error', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => 'jsonpcallback(not-json',
        });
        const js = buildCheckAuthJs(imoocProfile.checkAuth.toString());
        const page = evalPage(mockFetch);
        const result = await page.evaluate(js);

        expect(result.isAuthenticated).toBe(false);
        expect(result.error).toBeTruthy();
    });
});

// ── publish：成功路径 ─────────────────────────────────────────────────────────
describe('publish：成功路径', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__imoocPublished; });

    it('发出 savedraft 请求，返回草稿 id 和 url', async () => {
        const requests = [];
        const mockFetch = vi.fn(async (url, opts) => {
            requests.push({ url, opts });
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ result: 0, data: '9981' }),
                json: async () => ({ result: 0, data: '9981' }),
            };
        });

        // 直接在 jsdom 里跑 publish 函数，无需完整 buildPublishJs
        const page = evalPage(mockFetch);
        const publishSrc = imoocProfile.publish.toString();
        const js = `(async () => {
            var PP = {};
            const __publish = (${publishSrc});
            return await __publish({ title: '慕课测试文章', content: '# 正文', draftOnly: true }, PP);
        })()`;
        const result = await page.evaluate(js);

        expect(result.ok).toBe(true);
        expect(result.id).toBe('9981');
        expect(result.url).toBe('https://www.imooc.com/article/draft/id/9981');
        expect(result.draft).toBe(true);

        // 验证请求结构
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe('https://www.imooc.com/article/savedraft');
        expect(requests[0].opts.method).toBe('POST');
        const bodyStr = requests[0].opts.body instanceof URLSearchParams
            ? requests[0].opts.body.toString()
            : String(requests[0].opts.body);
        expect(bodyStr).toContain('title=%E6%85%95%E8%AF%BE%E6%B5%8B%E8%AF%95%E6%96%87%E7%AB%A0');
        expect(bodyStr).toContain('editor=0');
    });
});

// ── publish：失败路径 ─────────────────────────────────────────────────────────
describe('publish：失败路径', () => {
    it('服务端返回 data 为 null 时返回 ok:false', async () => {
        const mockFetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ result: -1, msg: '发布失败' }),
            json: async () => ({ result: -1, msg: '发布失败', data: null }),
        }));
        const page = evalPage(mockFetch);
        const publishSrc = imoocProfile.publish.toString();
        const js = `(async () => {
            var PP = {};
            const __publish = (${publishSrc});
            return await __publish({ title: '慕课测试', content: '内容', draftOnly: true }, PP);
        })()`;
        const result = await page.evaluate(js);

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('savedraft');
    });

    it('HTTP 非 200 时返回 ok:false 并带 status', async () => {
        const mockFetch = vi.fn(async () => ({
            ok: false,
            status: 403,
            text: async () => '禁止访问',
        }));
        const page = evalPage(mockFetch);
        const publishSrc = imoocProfile.publish.toString();
        const js = `(async () => {
            var PP = {};
            const __publish = (${publishSrc});
            return await __publish({ title: '慕课测试', content: '内容', draftOnly: true }, PP);
        })()`;
        const result = await page.evaluate(js);

        expect(result.ok).toBe(false);
        expect(result.status).toBe(403);
    });
});

// ── 图片 uploadFn：成功 + 失败路径 ──────────────────────────────────────────
describe('image.uploadFn', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('下载图片字节并上传到慕课图床，返回 https 绝对 URL', async () => {
        const mockFetch = vi.fn(async (url) => {
            if (url.includes('orig.com')) {
                // 模拟图片下载
                return {
                    ok: true,
                    blob: async () => new Blob(['fake-image'], { type: 'image/jpeg' }),
                };
            }
            // 模拟上传响应，返回协议相对 URL
            return {
                ok: true,
                json: async () => ({ result: 0, data: { imgpath: '//img.imooc.com/abc.jpg' } }),
            };
        });

        const page = evalPage(mockFetch);
        const uploadFnSrc = imoocProfile.image.uploadFn.toString();
        const js = `(async () => {
            var PP = {};
            const __upload = (${uploadFnSrc});
            return await __upload('https://orig.com/photo.jpg', PP);
        })()`;
        const result = await page.evaluate(js);

        expect(result.url).toBe('https://img.imooc.com/abc.jpg');
    });

    it('图片下载失败时抛出错误', async () => {
        const mockFetch = vi.fn(async () => ({
            ok: false,
            status: 404,
            blob: async () => new Blob([]),
        }));

        const page = evalPage(mockFetch);
        const uploadFnSrc = imoocProfile.image.uploadFn.toString();
        const js = `(async () => {
            var PP = {};
            const __upload = (${uploadFnSrc});
            try {
                return await __upload('https://orig.com/missing.jpg', PP);
            } catch (e) {
                return { error: e.message };
            }
        })()`;
        const result = await page.evaluate(js);

        expect(result.error).toContain('图片下载失败');
    });
});

// ── buildPublishJs 管线：markdown 平台跳过预处理 ──────────────────────────
describe('buildPublishJs 管线集成（markdown 平台）', () => {
    it('markdown 平台生成的 JS 含自定义 uploadFn 管线，且运行时跳过预处理', async () => {
        const js = buildPublishJs(
            {
                title: '测试',
                content: '# 正文',
                outputFormat: 'markdown',
                preprocessConfig: null,
                imageSpec: null,
                imageSkip: [],
            },
            imoocProfile.publish.toString(),
            imoocProfile.image.uploadFn.toString(),
        );
        // 应含自定义 uploadFn 路径（而非声明式 spec 路径）
        expect(js).toContain('PP.processImagesWith');
        expect(js).toContain('__upload');
        // 预处理条件：outputFormat=markdown 时运行时不会真正调 PP.preprocess
        // （条件 `I.outputFormat === "html"` 不满足），这里验证条件语句的存在
        expect(js).toContain('outputFormat === "html"');
        // 最终的管线逻辑结构正确
        expect(js).toContain('PP.processImagesWith(content');
        expect(js).toContain('__publish(');
    });
});
