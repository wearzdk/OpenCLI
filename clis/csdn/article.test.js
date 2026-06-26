// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { csdnProfile } from './article.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';
import { buildPublishJs } from '../_shared/article/publish.js';

// ── 辅助：创建伪 page 对象（单次 evaluate 在 jsdom 里真跑）─────────────────────
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
describe('csdnProfile 基本字段', () => {
    it('outputFormat 为 markdown', () => {
        expect(csdnProfile.outputFormat).toBe('markdown');
    });

    it('home 指向 CSDN 编辑器', () => {
        expect(csdnProfile.home).toBe('https://editor.csdn.net/md/');
    });

    it('image.skip 包含 CSDN 图床域名', () => {
        expect(Array.isArray(csdnProfile.image.skip)).toBe(true);
        const skip = csdnProfile.image.skip;
        expect(skip.some((s) => s.includes('csdnimg.cn'))).toBe(true);
        expect(skip.some((s) => s.includes('csdn.net'))).toBe(true);
    });

    it('image.uploadFn 是函数（自定义上传）', () => {
        expect(typeof csdnProfile.image.uploadFn).toBe('function');
    });

    it('publish 是函数', () => {
        expect(typeof csdnProfile.publish).toBe('function');
    });

    it('checkAuth 是函数', () => {
        expect(typeof csdnProfile.checkAuth).toBe('function');
    });
});

// ── checkAuth：登录检测 ────────────────────────────────────────────────────────
describe('checkAuth（登录检测）', () => {
    it('已登录：返回账号信息', async () => {
        const fetchImpl = vi.fn(async (url) => ({
            ok: true,
            status: 200,
            json: async () => ({
                code: 200,
                data: {
                    name: 'testuser123',
                    nickname: '测试用户',
                    avatar: 'https://profile.csdnimg.cn/avatar.jpg',
                    blog_url: 'https://blog.csdn.net/testuser123',
                },
            }),
        }));

        const js = buildCheckAuthJs(csdnProfile.checkAuth.toString());
        const page = evalPage(fetchImpl);
        const r = await page.evaluate(js);

        expect(r.isAuthenticated).toBe(true);
        expect(r.userId).toBe('testuser123');
        expect(r.username).toBe('测试用户');
        expect(r.avatar).toContain('csdnimg.cn');
    });

    it('未登录：isAuthenticated 为 false', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ code: 401, data: null }),
        }));

        const js = buildCheckAuthJs(csdnProfile.checkAuth.toString());
        const page = evalPage(fetchImpl);
        const r = await page.evaluate(js);

        expect(r.isAuthenticated).toBe(false);
    });

    it('checkAuth 请求携带正确的 CSDN 签名 Headers', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ code: 401 }),
        }));

        const js = buildCheckAuthJs(csdnProfile.checkAuth.toString());
        const page = evalPage(fetchImpl);
        await page.evaluate(js);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchImpl.mock.calls[0];
        expect(url).toContain('bizapi.csdn.net');
        expect(url).toContain('getBaseInfo');
        // 验证签名 Headers 存在
        expect(opts.headers['x-ca-key']).toBe('203803574');
        expect(opts.headers['x-ca-nonce']).toMatch(/^[0-9a-f-]{36}$/);
        expect(typeof opts.headers['x-ca-signature']).toBe('string');
        expect(opts.headers['x-ca-signature'].length).toBeGreaterThan(10);
        expect(opts.headers['x-ca-signature-headers']).toBe('x-ca-key,x-ca-nonce');
    });
});

// ── publish：发布函数 ──────────────────────────────────────────────────────────
describe('publish（草稿模式）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__csdn_published; });

    it('草稿模式：发布成功，返回编辑器 URL', async () => {
        const fetchImpl = vi.fn(async (url) => {
            // saveArticle 请求
            if (url.includes('saveArticle')) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ code: 200, data: { id: '123456789' } }),
                };
            }
            return { ok: false, status: 404, text: async () => '{}' };
        });

        const ctx = {
            title: '测试文章',
            content: '# 标题\n\n正文内容',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: ['csdnimg.cn', 'csdn.net'],
        };
        const js = buildPublishJs(ctx, csdnProfile.publish.toString(), csdnProfile.image.uploadFn.toString());
        const page = evalPage(fetchImpl);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);
        expect(result.draft).toBe(true);
        expect(result.id).toBe('123456789');
        expect(result.url).toContain('editor.csdn.net');
        expect(result.url).toContain('123456789');
    });

    it('忠实 Wechatsync：只调一次 saveArticle(status:2 草稿)，content 传 HTML，恒返回草稿', async () => {
        let callCount = 0;
        let savedBody = null;
        const fetchImpl = vi.fn(async (url, init) => {
            if (url.includes('saveArticle')) {
                callCount++;
                try { savedBody = JSON.parse(init.body); } catch (e) {}
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ code: 200, data: { id: '987654321' } }),
                };
            }
            return { ok: false, status: 404, text: async () => '{}' };
        });

        const ctx = {
            title: '正式发布测试',
            content: '# 正文',
            markdown: '# 正文',
            html: '<h1>正文</h1>',          // 由编排器从 markdown 渲染，CSDN 的 content 字段要用它
            draftOnly: false,                // 即便非草稿模式，CSDN 此法也只存草稿
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: ['csdnimg.cn', 'csdn.net'],
        };
        const js = buildPublishJs(ctx, csdnProfile.publish.toString(), csdnProfile.image.uploadFn.toString());
        const page = evalPage(fetchImpl);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(callCount).toBe(1);            // 没有杜撰的第二步发布
        expect(savedBody.status).toBe(2);     // status:2 = 草稿
        expect(savedBody.content).toBe('<h1>正文</h1>'); // content 传 HTML，非空
        expect(result.ok).toBe(true);
        expect(result.draft).toBe(true);      // 忠实 Wechatsync：恒草稿
        expect(result.id).toBe('987654321');
        expect(result.url).toContain('editor.csdn.net');
    });

    it('saveArticle 失败：返回 ok=false 并带 stage=save', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: false,
            status: 500,
            text: async () => JSON.stringify({ code: 500, msg: '服务器错误' }),
        }));

        const ctx = {
            title: '失败测试',
            content: '内容',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, csdnProfile.publish.toString(), csdnProfile.image.uploadFn.toString());
        const page = evalPage(fetchImpl);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('save');
    });

    it('publish 请求携带正确的签名 Headers', async () => {
        const calls = [];
        const fetchImpl = vi.fn(async (url, opts) => {
            calls.push({ url, headers: opts && opts.headers });
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ code: 200, data: { id: '111' } }),
            };
        });

        const ctx = {
            title: '签名验证',
            content: '内容',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, csdnProfile.publish.toString(), csdnProfile.image.uploadFn.toString());
        const page = evalPage(fetchImpl);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        await p;

        expect(calls.length).toBeGreaterThan(0);
        const saveCall = calls.find((c) => c.url && c.url.includes('saveArticle'));
        expect(saveCall).toBeTruthy();
        expect(saveCall.headers['x-ca-key']).toBe('203803574');
        expect(typeof saveCall.headers['x-ca-signature']).toBe('string');
        expect(saveCall.headers['x-ca-signature'].length).toBeGreaterThan(10);
    });
});

// ── 图片转存（uploadFn）─────────────────────────────────────────────────────
describe('uploadFn（图片转存）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('图片在 skip 列表内不重传（csdnimg.cn 图片跳过）', async () => {
        // skip 由 page-runtime.js 的 processImagesWith 检查，但我们可以验证 skip 列表配置正确
        const skip = csdnProfile.image.skip;
        const csdnImgUrl = 'https://img-blog.csdnimg.cn/test.jpg';
        expect(skip.some((s) => csdnImgUrl.includes(s))).toBe(true);
    });

    it('uploadFn 走完整三步并返回 imageUrl', async () => {
        const fetchImpl = vi.fn(async (url) => {
            // 步骤一：下载图片
            if (url === 'https://example.com/test.png') {
                return {
                    ok: true,
                    blob: async () => new Blob(['fakepng'], { type: 'image/png' }),
                };
            }
            // 步骤三：获取上传签名
            if (url.includes('upload/signature')) {
                return {
                    ok: true,
                    json: async () => ({
                        code: 200,
                        data: {
                            filePath: 'blog/20260626/test.png',
                            host: 'https://csdn-img-blog.obs.cn-north-4.myhuaweicloud.com',
                            accessId: 'TESTKEY',
                            policy: 'base64policy==',
                            signature: 'base64sig==',
                            callbackUrl: 'https://callback.csdn.net/cb',
                            callbackBody: '{"imageUrl":"${x:filePath}"}',
                            callbackBodyType: 'application/json',
                            customParam: {
                                rtype: 'blog',
                                filePath: 'blog/20260626/test.png',
                                isAudit: 0,
                                'x-image-app': 'direct_blog_markdown',
                                type: 'image',
                                'x-image-suffix': 'png',
                                username: 'testuser123',
                            },
                        },
                    }),
                };
            }
            // 步骤四：上传到华为云 OBS（回调响应）
            if (url.includes('obs.cn-north-4.myhuaweicloud.com')) {
                return {
                    ok: true,
                    json: async () => ({
                        code: 200,
                        data: { imageUrl: 'https://img-blog.csdnimg.cn/blog/20260626/test.png' },
                    }),
                };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });

        // 在 jsdom 里直接求值 uploadFn（注入 PP 占位符）
        const fnSrc = csdnProfile.image.uploadFn.toString();
        const js = `(async () => {
            var PP = {};
            var __upload = (${fnSrc});
            return await __upload('https://example.com/test.png', PP);
        })()`;
        const pf = globalThis.fetch;
        globalThis.fetch = fetchImpl;
        try {
            // eslint-disable-next-line no-eval
            const result = await (0, eval)(js);
            expect(result.url).toBe('https://img-blog.csdnimg.cn/blog/20260626/test.png');
        } finally {
            globalThis.fetch = pf;
        }
    });

    it('获取签名失败时降级返回原始 URL', async () => {
        const fetchImpl = vi.fn(async (url) => {
            if (url === 'https://example.com/fallback.jpg') {
                return {
                    ok: true,
                    blob: async () => new Blob(['fakejpg'], { type: 'image/jpeg' }),
                };
            }
            // 签名接口返回失败
            if (url.includes('upload/signature')) {
                return {
                    ok: true,
                    json: async () => ({ code: 500, data: null }),
                };
            }
            return { ok: false, status: 500, json: async () => ({}) };
        });

        const fnSrc = csdnProfile.image.uploadFn.toString();
        const js = `(async () => {
            var PP = {};
            var __upload = (${fnSrc});
            return await __upload('https://example.com/fallback.jpg', PP);
        })()`;
        const pf = globalThis.fetch;
        globalThis.fetch = fetchImpl;
        try {
            // eslint-disable-next-line no-eval
            const result = await (0, eval)(js);
            // 降级返回原始 URL
            expect(result.url).toBe('https://example.com/fallback.jpg');
        } finally {
            globalThis.fetch = pf;
        }
    });
});
