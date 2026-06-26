// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';
import { baijiahaoProfile } from './article.js';

// ── 辅助：在 jsdom 里模拟 page.evaluate，并替换 globalThis.fetch ──────────
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

// ── 基础 profile 验证 ───────────────────────────────────────────────────────

describe('baijiahaoProfile 基础字段', () => {
    it('outputFormat 为 html', () => {
        expect(baijiahaoProfile.outputFormat).toBe('html');
    });

    it('home 指向百家号', () => {
        expect(baijiahaoProfile.home).toBe('https://baijiahao.baidu.com');
    });

    it('preprocessConfig 存在（对象）', () => {
        expect(baijiahaoProfile.preprocessConfig).toBeDefined();
        expect(typeof baijiahaoProfile.preprocessConfig).toBe('object');
    });

    it('image.skip 包含百度图床域名', () => {
        const skip = baijiahaoProfile.image?.skip ?? [];
        expect(skip.some(d => d.includes('bdstatic.com'))).toBe(true);
        expect(skip.some(d => d.includes('bcebos.com'))).toBe(true);
    });

    it('image.uploadFn 是函数', () => {
        expect(typeof baijiahaoProfile.image?.uploadFn).toBe('function');
    });

    it('publish 是函数', () => {
        expect(typeof baijiahaoProfile.publish).toBe('function');
    });

    it('checkAuth 是函数', () => {
        expect(typeof baijiahaoProfile.checkAuth).toBe('function');
    });
});

// ── publish 函数：请求结构验证 ───────────────────────────────────────────────

describe('profile.publish 请求结构', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__bjh_published; });

    // 构造一个成功 fetch：编辑页返回 token，保存接口返回成功 JSONP
    function makeSuccessFetch() {
        return vi.fn(async (url, opts) => {
            if (url.includes('/builder/rc/edit')) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => `<html><script>window.__BJH__INIT__AUTH__ = 'test-auth-token-abc'</script></html>`,
                };
            }
            if (url.includes('/pcui/article/save')) {
                // 保存调用到来后记录请求参数供断言
                globalThis.__bjh_published = { url, opts };
                return {
                    ok: true,
                    status: 200,
                    text: async () => `bjhdraft({"errno":0,"errmsg":"success","ret":{"article_id":"123456789"}})`,
                };
            }
            throw new Error('未预期的 fetch 调用: ' + url);
        });
    }

    it('发布成功路径：取 token → POST save → 解析 JSONP → 返回草稿 URL', async () => {
        const fetchMock = makeSuccessFetch();
        const page = evalPage(fetchMock);

        const ctx = {
            title: '测试文章',
            content: '<p>正文内容</p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: {},
            imageSpec: null,
            imageSkip: [],
        };

        const js = buildPublishJs(ctx, baijiahaoProfile.publish.toString(), baijiahaoProfile.image.uploadFn.toString());
        const result = await page.evaluate(js);

        expect(result.ok).toBe(true);
        expect(result.id).toBe('123456789');
        expect(result.url).toContain('article_id=123456789');
        expect(result.draft).toBe(true);

        // 确认发出了两次 fetch：编辑页 + 保存
        const calls = fetchMock.mock.calls.map(c => c[0]);
        expect(calls.some(u => u.includes('/builder/rc/edit'))).toBe(true);
        expect(calls.some(u => u.includes('/pcui/article/save'))).toBe(true);
    });

    it('发布请求带正确的 Content-Type 和 token header', async () => {
        const fetchMock = makeSuccessFetch();
        const page = evalPage(fetchMock);

        const ctx = {
            title: '头部验证',
            content: '<p>hello</p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: {},
            imageSpec: null,
            imageSkip: [],
        };

        const js = buildPublishJs(ctx, baijiahaoProfile.publish.toString(), baijiahaoProfile.image.uploadFn.toString());
        await page.evaluate(js);

        // 找到 save 调用，验证 headers
        const saveCall = fetchMock.mock.calls.find(c => c[0].includes('/pcui/article/save'));
        expect(saveCall).toBeDefined();
        const headers = saveCall[1]?.headers ?? {};
        expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(headers['token']).toBe('test-auth-token-abc');
    });

    it('发布请求体包含必要字段（title / content / type=news）', async () => {
        const fetchMock = makeSuccessFetch();
        const page = evalPage(fetchMock);

        const ctx = {
            title: '字段验证文章',
            content: '<p>字段测试</p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: {},
            imageSpec: null,
            imageSkip: [],
        };

        const js = buildPublishJs(ctx, baijiahaoProfile.publish.toString(), baijiahaoProfile.image.uploadFn.toString());
        await page.evaluate(js);

        // 找到 save 调用，验证 body 字符串中包含各字段
        const saveCall = fetchMock.mock.calls.find(c => c[0].includes('/pcui/article/save'));
        const bodyStr = saveCall[1]?.body?.toString() ?? '';
        expect(bodyStr).toContain('title=');
        expect(bodyStr).toContain('%E5%AD%97%E6%AE%B5%E9%AA%8C%E8%AF%81%E6%96%87%E7%AB%A0'); // URL 编码的「字段验证文章」
        expect(bodyStr).toContain('type=news');
    });

    it('编辑页 token 提取失败时返回 ok:false', async () => {
        const fetchMock = vi.fn(async (url) => {
            if (url.includes('/builder/rc/edit')) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => `<html>没有 token 的页面</html>`,
                };
            }
            throw new Error('未预期的 fetch 调用: ' + url);
        });

        const page = evalPage(fetchMock);
        const ctx = {
            title: '失败测试',
            content: '<p>x</p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: {},
            imageSpec: null,
            imageSkip: [],
        };

        const js = buildPublishJs(ctx, baijiahaoProfile.publish.toString(), baijiahaoProfile.image.uploadFn.toString());
        const result = await page.evaluate(js);

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('auth');
        expect(result.message).toContain('登录失效');
    });

    it('save 接口返回错误时返回 ok:false', async () => {
        const fetchMock = vi.fn(async (url) => {
            if (url.includes('/builder/rc/edit')) {
                return {
                    ok: true, status: 200,
                    text: async () => `<script>window.__BJH__INIT__AUTH__ = 'tok'</script>`,
                };
            }
            if (url.includes('/pcui/article/save')) {
                return {
                    ok: false, status: 403,
                    text: async () => `bjhdraft({"errno":403,"errmsg":"无权限"})`,
                };
            }
            throw new Error('未预期的 fetch 调用: ' + url);
        });

        const page = evalPage(fetchMock);
        const ctx = {
            title: '错误测试',
            content: '<p>x</p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: {},
            imageSpec: null,
            imageSkip: [],
        };

        const js = buildPublishJs(ctx, baijiahaoProfile.publish.toString(), baijiahaoProfile.image.uploadFn.toString());
        const result = await page.evaluate(js);

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('save');
    });
});

// ── checkAuth 函数：登录态解析验证 ─────────────────────────────────────────

describe('profile.checkAuth 登录态解析', () => {
    it('已登录：解析 user 信息', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                errno: 0,
                errmsg: 'success',
                data: {
                    user: {
                        userid: 'uid-001',
                        name: '测试用户',
                        avatar: 'https://example.com/avatar.jpg',
                    },
                },
            }),
        }));

        const js = buildCheckAuthJs(baijiahaoProfile.checkAuth.toString());

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        let r;
        try {
            // eslint-disable-next-line no-eval
            r = await (0, eval)(js);
        } finally {
            globalThis.fetch = pf;
        }

        expect(r.isAuthenticated).toBe(true);
        expect(r.userId).toBe('uid-001');
        expect(r.username).toBe('测试用户');
        expect(r.avatar).toBe('https://example.com/avatar.jpg');
    });

    it('未登录：errmsg 非 success 时返回 isAuthenticated:false', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                errno: 110,
                errmsg: 'not_login',
                data: null,
            }),
        }));

        const js = buildCheckAuthJs(baijiahaoProfile.checkAuth.toString());

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        let r;
        try {
            // eslint-disable-next-line no-eval
            r = await (0, eval)(js);
        } finally {
            globalThis.fetch = pf;
        }

        expect(r.isAuthenticated).toBe(false);
    });

    it('网络异常时返回 isAuthenticated:false 并附 error 信息', async () => {
        const fetchMock = vi.fn(async () => { throw new Error('网络超时'); });

        const js = buildCheckAuthJs(baijiahaoProfile.checkAuth.toString());

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        let r;
        try {
            // eslint-disable-next-line no-eval
            r = await (0, eval)(js);
        } finally {
            globalThis.fetch = pf;
        }

        expect(r.isAuthenticated).toBe(false);
        expect(r.error).toContain('网络超时');
    });
});

// ── uploadFn：图片转存请求结构验证 ─────────────────────────────────────────

describe('profile.image.uploadFn 图片转存', () => {
    it('下载图片字节后 POST 到上传接口，返回 https_url', async () => {
        // 构造一个 PP stub（uploadFn 签名是 async (src, PP)，但本身不用 PP 的方法）
        const PP = {};
        const uploadFn = baijiahaoProfile.image.uploadFn;

        const calls = [];
        const fetchMock = vi.fn(async (url, opts) => {
            calls.push({ url, opts });
            if (url === 'https://example.com/img.jpg') {
                // 模拟图片下载
                return {
                    ok: true,
                    blob: async () => new Blob(['fake-image-bytes'], { type: 'image/jpeg' }),
                };
            }
            if (url.includes('/pcui/picture/uploadproxy')) {
                return {
                    ok: true,
                    json: async () => ({
                        errno: 0,
                        errmsg: 'success',
                        ret: { https_url: 'https://bcebos.com/bjh/new-image.jpg' },
                    }),
                };
            }
            throw new Error('未预期的 fetch 调用: ' + url);
        });

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        let result;
        try {
            result = await uploadFn('https://example.com/img.jpg', PP);
        } finally {
            globalThis.fetch = pf;
        }

        expect(result.url).toBe('https://bcebos.com/bjh/new-image.jpg');

        // 确认有下载调用
        const downloadCall = calls.find(c => c.url === 'https://example.com/img.jpg');
        expect(downloadCall).toBeDefined();
        expect(downloadCall.opts?.credentials).toBe('omit');

        // 确认有上传调用
        const uploadCall = calls.find(c => c.url.includes('/pcui/picture/uploadproxy'));
        expect(uploadCall).toBeDefined();
        expect(uploadCall.opts?.method).toBe('POST');
        expect(uploadCall.opts?.credentials).toBe('include');
    });

    it('上传失败时抛出错误', async () => {
        const PP = {};
        const uploadFn = baijiahaoProfile.image.uploadFn;

        const fetchMock = vi.fn(async (url) => {
            if (url === 'https://example.com/bad.jpg') {
                return {
                    ok: true,
                    blob: async () => new Blob(['bytes'], { type: 'image/jpeg' }),
                };
            }
            return {
                ok: true,
                json: async () => ({ errno: 500, errmsg: '上传配额不足', ret: null }),
            };
        });

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        try {
            await expect(uploadFn('https://example.com/bad.jpg', PP)).rejects.toThrow('上传配额不足');
        } finally {
            globalThis.fetch = pf;
        }
    });
});
