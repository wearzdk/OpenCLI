// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';
import { evalPageRuntime } from '../_shared/article/page-runtime.js';
import { sohuProfile } from './article.js';

// ── 测试辅助：构造一个能在 jsdom 里运行 evaluate 的假 page ─────────────────────
function makePage(fetchImpl) {
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

// 搜狐账号列表接口的标准返回
const MOCK_ACCOUNT_RESP = {
    code: 2000000,
    data: {
        data: [
            {
                accounts: [
                    { id: '12345678', nickName: '测试搜狐号', avatar: 'https://sohu.com/avatar.jpg' },
                ],
            },
        ],
    },
};

// ── profile 基础属性 ───────────────────────────────────────────────────────────
describe('sohuProfile 基础属性', () => {
    it('outputFormat 为 html', () => {
        expect(sohuProfile.outputFormat).toBe('html');
    });

    it('home 指向搜狐号管理后台', () => {
        expect(sohuProfile.home).toMatch(/mp\.sohu\.com/);
    });

    it('image.skip 包含 sohu.com（跳过已在搜狐图床的图）', () => {
        expect(sohuProfile.image.skip).toContain('sohu.com');
    });

    it('image.uploadFn 是函数', () => {
        expect(typeof sohuProfile.image.uploadFn).toBe('function');
    });

    it('publish 是函数', () => {
        expect(typeof sohuProfile.publish).toBe('function');
    });

    it('checkAuth 是函数', () => {
        expect(typeof sohuProfile.checkAuth).toBe('function');
    });
});

// ── checkAuth：在 jsdom 里 eval，断言请求结构和返回解析 ─────────────────────────
describe('checkAuth（页面内 evaluate）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('已登录：解析出 isAuthenticated=true、userId、username', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => MOCK_ACCOUNT_RESP,
        });
        const js = buildCheckAuthJs(sohuProfile.checkAuth.toString());
        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.isAuthenticated).toBe(true);
        expect(result.userId).toBe('12345678');
        expect(result.username).toBe('测试搜狐号');
    });

    it('未登录（code !== 2000000）：返回 isAuthenticated=false', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ code: 401, data: null }),
        });
        const js = buildCheckAuthJs(sohuProfile.checkAuth.toString());
        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.isAuthenticated).toBe(false);
    });

    it('子账号为空时返回 isAuthenticated=false', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                code: 2000000,
                data: { data: [{ accounts: [] }] },
            }),
        });
        const js = buildCheckAuthJs(sohuProfile.checkAuth.toString());
        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.isAuthenticated).toBe(false);
    });

    it('多子账号时 username 含数量提示', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                code: 2000000,
                data: {
                    data: [{
                        accounts: [
                            { id: '111', nickName: '主账号', avatar: '' },
                            { id: '222', nickName: '子账号A', avatar: '' },
                        ],
                    }],
                },
            }),
        });
        const js = buildCheckAuthJs(sohuProfile.checkAuth.toString());
        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.isAuthenticated).toBe(true);
        expect(result.username).toContain('2');
        expect(result.username).toContain('子账号');
    });

    it('fetch 抛异常时返回 isAuthenticated=false 且带 error', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('网络错误'));
        const js = buildCheckAuthJs(sohuProfile.checkAuth.toString());
        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.isAuthenticated).toBe(false);
        expect(result.error).toMatch(/网络错误/);
    });
});

// ── publish：发布请求结构断言 ──────────────────────────────────────────────────
describe('publish（页面内 evaluate）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    function buildPublishContext(overrides = {}) {
        return {
            title: '测试标题',
            content: '<p>正文内容</p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: sohuProfile.preprocessConfig,
            imageSpec: null,
            imageSkip: sohuProfile.image.skip,
            ...overrides,
        };
    }

    it('成功发布草稿：返回 ok=true、id、url 含草稿路径', async () => {
        // fetch 调用顺序：1. 账号列表（checkAuth in publish）；2. 草稿保存
        const calls = [];
        const fetchMock = vi.fn().mockImplementation(async (url) => {
            calls.push(url);
            if (url.includes('account/list')) {
                return { ok: true, status: 200, json: async () => MOCK_ACCOUNT_RESP, text: async () => JSON.stringify(MOCK_ACCOUNT_RESP) };
            }
            if (url.includes('draft/v2')) {
                const body = { success: true, data: '99887766' };
                return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
            }
            return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
        });

        const ctx = buildPublishContext();
        const js = buildPublishJs(ctx, sohuProfile.publish.toString(), sohuProfile.image.uploadFn.toString());
        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);
        expect(result.id).toBe('99887766');
        expect(result.url).toContain('mp.sohu.com');
        expect(result.url).toContain('99887766');
        expect(result.draft).toBe(true);

        // 确认发往正确的草稿保存接口
        const draftCall = calls.find(u => u.includes('draft/v2'));
        expect(draftCall).toBeTruthy();
        expect(draftCall).toContain('12345678');
    });

    it('账号接口返回非 2000000 时，publish 返回 ok=false 且 stage=auth', async () => {
        const fetchMock = vi.fn().mockImplementation(async (url) => {
            if (url.includes('account/list')) {
                return { ok: true, status: 200, json: async () => ({ code: 401 }), text: async () => JSON.stringify({ code: 401 }) };
            }
            return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
        });

        const ctx = buildPublishContext();
        const js = buildPublishJs(ctx, sohuProfile.publish.toString(), sohuProfile.image.uploadFn.toString());
        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('auth');
    });

    it('草稿保存接口失败时，publish 返回 ok=false 且 stage=draft', async () => {
        const fetchMock = vi.fn().mockImplementation(async (url) => {
            if (url.includes('account/list')) {
                return { ok: true, status: 200, json: async () => MOCK_ACCOUNT_RESP, text: async () => JSON.stringify(MOCK_ACCOUNT_RESP) };
            }
            if (url.includes('draft/v2')) {
                return { ok: true, status: 200, json: async () => ({ success: false, msg: '标题太长' }), text: async () => JSON.stringify({ success: false, msg: '标题太长' }) };
            }
            return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
        });

        const ctx = buildPublishContext();
        const js = buildPublishJs(ctx, sohuProfile.publish.toString(), sohuProfile.image.uploadFn.toString());
        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('draft');
        expect(result.message).toContain('标题太长');
    });

    it('草稿保存：请求 body 包含 title、content、accountId 字段', async () => {
        let capturedBody = null;
        const fetchMock = vi.fn().mockImplementation(async (url, opts) => {
            if (url.includes('account/list')) {
                return { ok: true, status: 200, json: async () => MOCK_ACCOUNT_RESP, text: async () => JSON.stringify(MOCK_ACCOUNT_RESP) };
            }
            if (url.includes('draft/v2')) {
                capturedBody = JSON.parse(opts.body);
                const body = { success: true, data: '111222' };
                return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
            }
            return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
        });

        const ctx = buildPublishContext({ title: '搜狐文章测试', content: '<p>你好搜狐</p>' });
        const js = buildPublishJs(ctx, sohuProfile.publish.toString(), sohuProfile.image.uploadFn.toString());
        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        await p;

        expect(capturedBody).not.toBeNull();
        expect(capturedBody.title).toBe('搜狐文章测试');
        expect(capturedBody.content).toContain('你好搜狐');
        expect(capturedBody.accountId).toBe(12345678);
    });
});

// ── uploadFn：图片转存请求结构断言 ────────────────────────────────────────────
describe('uploadFn（页面内执行图片转存）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('成功上传：先拉账号，再下载图片字节，再上传，返回新 url', async () => {
        const calls = [];
        const fetchMock = vi.fn().mockImplementation(async (url, opts) => {
            calls.push({ url, method: (opts && opts.method) || 'GET' });
            if (url.includes('account/list')) {
                return { ok: true, status: 200, json: async () => MOCK_ACCOUNT_RESP };
            }
            if (url.includes('orig.com')) {
                // 下载图片字节
                return { ok: true, blob: async () => new Blob(['fake-img'], { type: 'image/jpeg' }) };
            }
            if (url.includes('outerUpload')) {
                return { ok: true, json: async () => ({ url: 'https://img.sohu.com/rehosted.jpg' }) };
            }
            return { ok: false, json: async () => ({}) };
        });

        // 在 jsdom 里直接 eval uploadFn 调用
        const uploadFnStr = sohuProfile.image.uploadFn.toString();
        const js = `(async () => {
            const PP = {};
            const __upload = (${uploadFnStr});
            return await __upload('https://orig.com/img.jpg', PP);
        })()`;

        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.url).toBe('https://img.sohu.com/rehosted.jpg');
        // 确认请求顺序：账号列表 → 图片下载 → 上传
        expect(calls[0].url).toContain('account/list');
        expect(calls[1].url).toContain('orig.com');
        expect(calls[2].url).toContain('outerUpload');
        expect(calls[2].url).toContain('12345678');
    });

    it('上传接口无 url 字段时抛出错误', async () => {
        const fetchMock = vi.fn().mockImplementation(async (url) => {
            if (url.includes('account/list')) {
                return { ok: true, json: async () => MOCK_ACCOUNT_RESP };
            }
            if (url.includes('orig.com')) {
                return { ok: true, blob: async () => new Blob(['x'], { type: 'image/jpeg' }) };
            }
            if (url.includes('outerUpload')) {
                return { ok: true, json: async () => ({ msg: '格式不支持' }) };
            }
            return { ok: false, json: async () => ({}) };
        });

        const uploadFnStr = sohuProfile.image.uploadFn.toString();
        const js = `(async () => {
            const PP = {};
            const __upload = (${uploadFnStr});
            try {
                return await __upload('https://orig.com/img.jpg', PP);
            } catch (e) {
                return { error: e.message };
            }
        })()`;

        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.error).toMatch(/上传失败/);
        expect(result.error).toContain('格式不支持');
    });

    it('已在搜狐图床的图（skip sohu.com）不触发上传', async () => {
        // 通过 buildPublishJs 走完整管线，sohu.com 图片应被跳过
        const fetchMock = vi.fn().mockImplementation(async (url) => {
            if (url.includes('account/list')) {
                return { ok: true, status: 200, json: async () => MOCK_ACCOUNT_RESP, text: async () => JSON.stringify(MOCK_ACCOUNT_RESP) };
            }
            if (url.includes('draft/v2')) {
                const body = { success: true, data: '555' };
                return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
            }
            return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
        });

        const ctx = {
            title: '含搜狐图的文章',
            content: '<p><img src="https://img.sohu.com/already.jpg" /></p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: sohuProfile.preprocessConfig,
            imageSpec: null,
            imageSkip: sohuProfile.image.skip,
        };
        const js = buildPublishJs(ctx, sohuProfile.publish.toString(), sohuProfile.image.uploadFn.toString());
        const page = makePage(fetchMock);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);
        // 没有上传操作（只有账号列表+草稿保存），已在搜狐图床的图被跳过
        expect(result.uploaded).toHaveLength(0);
    });
});
