// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { oschinaProfile } from './article.js';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';

// ── 辅助：在 jsdom 里模拟页面 evaluate 环境 ─────────────────────────────────
// 用给定的 fetch 实现在 jsdom 里跑一段 JS 字符串（等价于 page.evaluate）。
function evalPage(fetchImpl) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: async (js) => {
            const prev = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            try {
                // eslint-disable-next-line no-eval
                return await (0, eval)(js);
            } finally {
                globalThis.fetch = prev;
            }
        },
    };
}

// ── profile 基本声明检测 ─────────────────────────────────────────────────────
describe('oschinaProfile 声明检测', () => {
    it('outputFormat 为 markdown', () => {
        expect(oschinaProfile.outputFormat).toBe('markdown');
    });
    it('home 为开源中国写作入口', () => {
        expect(oschinaProfile.home).toBe('https://my.oschina.net');
    });
    it('图片 spec 使用 binary-multipart，指向正确接口', () => {
        const spec = oschinaProfile.image.spec;
        expect(spec.bodyType).toBe('binary-multipart');
        expect(spec.url).toContain('apiv1.oschina.net');
        expect(spec.url).toContain('uploadDetail');
        expect(spec.responsePath).toBe('result');
        expect(spec.fileField).toBe('file');
    });
    it('skip 域名涵盖开源中国图床', () => {
        expect(oschinaProfile.image.skip.some(d => d.includes('oschina'))).toBe(true);
    });
    it('publish 是函数', () => {
        expect(typeof oschinaProfile.publish).toBe('function');
    });
    it('checkAuth 是函数', () => {
        expect(typeof oschinaProfile.checkAuth).toBe('function');
    });
});

// ── checkAuth 解析测试 ───────────────────────────────────────────────────────
describe('checkAuth', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('已登录：正确解析 userId 和 username', async () => {
        const mockData = {
            success: true,
            result: {
                userId: 12345,
                userVo: { name: '测试用户', portraitUrl: 'https://avatar.oschina.net/test.png' },
            },
        };
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => mockData,
        });
        globalThis.fetch = fetchImpl;

        const js = buildCheckAuthJs(oschinaProfile.checkAuth.toString());
        const result = await (0, eval)(js);

        expect(result.isAuthenticated).toBe(true);
        expect(result.userId).toBe('12345');
        expect(result.username).toBe('测试用户');
        expect(result.avatar).toBe('https://avatar.oschina.net/test.png');
    });

    it('未登录：success=false 返回 isAuthenticated=false', async () => {
        const mockData = { success: false, message: '未登录' };
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => mockData,
        });
        globalThis.fetch = fetchImpl;

        const js = buildCheckAuthJs(oschinaProfile.checkAuth.toString());
        const result = await (0, eval)(js);

        expect(result.isAuthenticated).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it('HTTP 错误：返回 isAuthenticated=false', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => { throw new Error('not json'); },
        });
        globalThis.fetch = fetchImpl;

        const js = buildCheckAuthJs(oschinaProfile.checkAuth.toString());
        const result = await (0, eval)(js);

        expect(result.isAuthenticated).toBe(false);
    });

    it('网络异常：返回 isAuthenticated=false 并带 error', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('网络超时'));
        globalThis.fetch = fetchImpl;

        const js = buildCheckAuthJs(oschinaProfile.checkAuth.toString());
        const result = await (0, eval)(js);

        expect(result.isAuthenticated).toBe(false);
        expect(result.error).toContain('网络超时');
    });
});

// ── publish 成功路径测试 ─────────────────────────────────────────────────────
describe('publish（页面内函数）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__oschinaPublished; });

    // 构造一个模拟 fetch：
    //   - 第一次调用（getUserDetails）→ 返回用户信息
    //   - 第二次调用（save_draft）→ 返回草稿结果
    function makeFetch(draftId = '9999') {
        let callCount = 0;
        return vi.fn(async (url) => {
            callCount++;
            if (url.includes('myDetails')) {
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        result: { userId: 88888, userVo: { name: '测试用户' } },
                    }),
                    text: async () => JSON.stringify({ success: true, result: { userId: 88888 } }),
                };
            }
            if (url.includes('save_draft')) {
                return {
                    ok: true,
                    json: async () => ({ success: true, result: { id: Number(draftId) } }),
                    text: async () => JSON.stringify({ success: true, result: { id: Number(draftId) } }),
                };
            }
            // 兜底（图片转存等）
            return { ok: true, json: async () => ({}), text: async () => '{}' };
        });
    }

    it('发布成功：返回 ok=true，draft=true，url 含 userId 和 draftId', async () => {
        const fetchImpl = makeFetch('9999');
        globalThis.fetch = fetchImpl;

        const publishFnSource = oschinaProfile.publish.toString();
        const ctx = {
            title: '测试文章标题',
            content: '## 这是 Markdown 正文\n\n内容在这里。',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, publishFnSource);
        const result = await (0, eval)(js);

        expect(result.ok).toBe(true);
        expect(result.draft).toBe(true);
        expect(result.id).toBe('9999');
        expect(result.url).toContain('88888');
        expect(result.url).toContain('9999');
        expect(result.url).toContain('my.oschina.net');
    });

    it('获取 userId 失败时返回 ok=false，stage=auth', async () => {
        const fetchImpl = vi.fn(async (url) => {
            if (url.includes('myDetails')) {
                return {
                    ok: true,
                    json: async () => ({ success: false }),
                    text: async () => JSON.stringify({ success: false }),
                };
            }
            return { ok: true, json: async () => ({}), text: async () => '{}' };
        });
        globalThis.fetch = fetchImpl;

        const ctx = {
            title: '标题',
            content: '正文',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, oschinaProfile.publish.toString());
        const result = await (0, eval)(js);

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('auth');
    });

    it('save_draft 接口返回失败时 ok=false，stage=save_draft', async () => {
        const fetchImpl = vi.fn(async (url) => {
            if (url.includes('myDetails')) {
                return {
                    ok: true,
                    json: async () => ({ success: true, result: { userId: 111 } }),
                    text: async () => JSON.stringify({ success: true, result: { userId: 111 } }),
                };
            }
            if (url.includes('save_draft')) {
                return {
                    ok: false,
                    status: 500,
                    json: async () => ({ success: false, message: '服务器错误' }),
                    text: async () => JSON.stringify({ success: false, message: '服务器错误' }),
                };
            }
            return { ok: true, json: async () => ({}), text: async () => '{}' };
        });
        globalThis.fetch = fetchImpl;

        const ctx = {
            title: '标题',
            content: '正文',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, oschinaProfile.publish.toString());
        const result = await (0, eval)(js);

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('save_draft');
    });
});

// ── 图片转存请求结构验证 ─────────────────────────────────────────────────────
describe('图片转存（binary-multipart）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('上传请求为 FormData 格式，响应从 result 字段取新 URL', async () => {
        const newImageUrl = 'https://oscimg.oschina.net/uploaded/img.png';
        const capturedRequests = [];

        const fetchImpl = vi.fn(async (url, opts) => {
            capturedRequests.push({ url, opts });
            if (url.includes('myDetails')) {
                return {
                    ok: true,
                    json: async () => ({ success: true, result: { userId: 222 } }),
                    text: async () => JSON.stringify({ success: true, result: { userId: 222 } }),
                };
            }
            if (url.includes('uploadDetail')) {
                // 返回 result 字段（直接是 URL 字符串）
                return {
                    ok: true,
                    json: async () => ({ success: true, result: newImageUrl }),
                    text: async () => JSON.stringify({ success: true, result: newImageUrl }),
                };
            }
            if (url.includes('save_draft')) {
                return {
                    ok: true,
                    json: async () => ({ success: true, result: { id: 7777 } }),
                    text: async () => JSON.stringify({ success: true, result: { id: 7777 } }),
                };
            }
            // 模拟图片下载（binary-multipart 先 fetch 图片字节）
            return {
                ok: true,
                blob: async () => new Blob(['fakepng'], { type: 'image/png' }),
                json: async () => ({}),
                text: async () => '{}',
            };
        });

        // 注意：binary-multipart 转存流程：先 fetch 外链图，再 FormData POST 到上传接口
        const ctx = {
            title: '带图文章',
            content: '正文 ![测试图](https://external.example.com/img.png) 结尾',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: oschinaProfile.image.spec,
            imageSkip: oschinaProfile.image.skip,
        };
        const js = buildPublishJs(ctx, oschinaProfile.publish.toString());
        const p = (async () => {
            globalThis.fetch = fetchImpl;
            return await (0, eval)(js);
        })();
        await vi.runAllTimersAsync();
        const result = await p;

        // 转存成功后正文中的图片 URL 应被替换
        expect(result.ok).toBe(true);
        expect(result.uploaded).toHaveLength(1);
        expect(result.uploaded[0].url).toBe(newImageUrl);
        // 上传请求应该包含 FormData（binary-multipart）
        const uploadReq = capturedRequests.find(r => r.url.includes('uploadDetail'));
        expect(uploadReq).toBeTruthy();
        expect(uploadReq.opts.body).toBeInstanceOf(FormData);
    });

    it('图片来自 oschina.net 域时跳过转存', async () => {
        const fetchImpl = vi.fn(async (url) => {
            if (url.includes('myDetails')) {
                return {
                    ok: true,
                    json: async () => ({ success: true, result: { userId: 333 } }),
                    text: async () => JSON.stringify({ success: true, result: { userId: 333 } }),
                };
            }
            if (url.includes('save_draft')) {
                return {
                    ok: true,
                    json: async () => ({ success: true, result: { id: 8888 } }),
                    text: async () => JSON.stringify({ success: true, result: { id: 8888 } }),
                };
            }
            return { ok: true, json: async () => ({}), text: async () => '{}' };
        });

        const ctx = {
            title: '开源中国图',
            content: '正文 ![图](https://oscimg.oschina.net/already.png) 结尾',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: oschinaProfile.image.spec,
            imageSkip: oschinaProfile.image.skip,
        };
        const js = buildPublishJs(ctx, oschinaProfile.publish.toString());
        const p = (async () => {
            globalThis.fetch = fetchImpl;
            return await (0, eval)(js);
        })();
        await vi.runAllTimersAsync();
        const result = await p;

        // 已在开源中国的图片不应被转存
        expect(result.ok).toBe(true);
        expect(result.uploaded).toHaveLength(0);
        // 上传接口不应被调用
        const uploadCalls = fetchImpl.mock.calls.filter(([url]) => url.includes('uploadDetail'));
        expect(uploadCalls).toHaveLength(0);
    });
});
