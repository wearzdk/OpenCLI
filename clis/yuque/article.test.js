// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';
import { yuqueProfile } from './article.js';
import { yuqueAuthProfile } from './whoami.js';

// ── 测试工具：在 jsdom 里执行 evaluate 字符串，stub 全局 fetch ─────────────
function evalPage(fetchImpl) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: async (js) => {
            const origFetch = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            try {
                // eslint-disable-next-line no-eval
                return await (0, eval)(js);
            } finally {
                globalThis.fetch = origFetch;
            }
        },
    };
}

// ── 辅助：伪造 Response 对象 ────────────────────────────────────────────────
function mockResp(body, status = 200) {
    const txt = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => txt,
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
        blob: async () => new Blob([txt]),
    };
}

// ── 公共模拟数据 ────────────────────────────────────────────────────────────
const MOCK_COMMON_USED = {
    data: {
        books: [{
            target_id: 99,
            user: { id: 1001, name: '测试用户', avatar_url: 'https://cdn.nlark.com/avatar.png' },
        }],
    },
};
const MOCK_CREATE_DOC = { data: { id: 88888 } };
const MOCK_CONVERT = { data: { content: '<lake-content>正文</lake-content>' } };
const MOCK_SAVE = { data: {} };

// ── profile 结构校验 ────────────────────────────────────────────────────────
describe('yuqueProfile 结构', () => {
    it('outputFormat 为 markdown', () => {
        expect(yuqueProfile.outputFormat).toBe('markdown');
    });
    it('image 字段为 null（图片转存在 publish 内部处理）', () => {
        expect(yuqueProfile.image).toBeNull();
    });
    it('home 指向语雀 dashboard', () => {
        expect(yuqueProfile.home).toBe('https://www.yuque.com/dashboard');
    });
    it('publish 是函数', () => {
        expect(typeof yuqueProfile.publish).toBe('function');
    });
});

// ── checkAuth 登录检测 ──────────────────────────────────────────────────────
describe('yuqueAuthProfile.checkAuth', () => {
    beforeEach(() => {
        // 模拟 document.cookie 含 yuque_ctoken
        Object.defineProperty(document, 'cookie', {
            get: () => 'yuque_ctoken=test_csrf_token',
            configurable: true,
        });
    });
    afterEach(() => {
        // 还原 cookie
        Object.defineProperty(document, 'cookie', {
            get: () => '',
            configurable: true,
        });
    });

    it('已登录：返回 isAuthenticated=true + 用户信息', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(mockResp(MOCK_COMMON_USED));
        const js = buildCheckAuthJs(yuqueAuthProfile.checkAuth.toString());

        const pf = globalThis.fetch;
        globalThis.fetch = fetchImpl;
        let r;
        try { r = await (0, eval)(js); } finally { globalThis.fetch = pf; }

        expect(r.isAuthenticated).toBe(true);
        expect(r.userId).toBe('1001');
        expect(r.username).toBe('测试用户');
        expect(r.avatar).toContain('avatar.png');
    });

    it('未登录：books 为空 → isAuthenticated=false', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(mockResp({ data: { books: [] } }));
        const js = buildCheckAuthJs(yuqueAuthProfile.checkAuth.toString());

        const pf = globalThis.fetch;
        globalThis.fetch = fetchImpl;
        let r;
        try { r = await (0, eval)(js); } finally { globalThis.fetch = pf; }

        expect(r.isAuthenticated).toBe(false);
    });

    it('无 yuque_ctoken cookie → isAuthenticated=false', async () => {
        // 暂时覆盖 cookie 为空
        Object.defineProperty(document, 'cookie', {
            get: () => '',
            configurable: true,
        });
        const fetchImpl = vi.fn();
        const js = buildCheckAuthJs(yuqueAuthProfile.checkAuth.toString());

        const pf = globalThis.fetch;
        globalThis.fetch = fetchImpl;
        let r;
        try { r = await (0, eval)(js); } finally { globalThis.fetch = pf; }

        expect(r.isAuthenticated).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

// ── publish 发布成功路径（草稿模式）─────────────────────────────────────────
describe('yuqueProfile.publish — 草稿模式成功路径', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Object.defineProperty(document, 'cookie', {
            get: () => 'yuque_ctoken=test_csrf_token',
            configurable: true,
        });
    });
    afterEach(() => {
        vi.useRealTimers();
        Object.defineProperty(document, 'cookie', {
            get: () => '',
            configurable: true,
        });
    });

    it('草稿模式：建文档 → 无外链图 → 转换 → 保存；返回 ok=true draft=true', async () => {
        const calls = [];
        const fetchImpl = vi.fn(async (url, opts) => {
            calls.push({ url, method: (opts && opts.method) || 'GET' });
            if (url.includes('common_used')) return mockResp(MOCK_COMMON_USED);
            if (url === 'https://www.yuque.com/api/docs' && (opts && opts.method) === 'POST') return mockResp(MOCK_CREATE_DOC);
            if (url.includes('/api/docs/convert')) return mockResp(MOCK_CONVERT);
            if (url.includes('/content')) return mockResp(MOCK_SAVE);
            return mockResp({ ok: true });
        });

        const ctx = {
            title: '测试标题',
            content: '# 你好语雀\n\n这是测试正文。',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, yuqueProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);
        expect(result.draft).toBe(true);
        expect(result.id).toBe('88888');
        expect(result.url).toContain('88888');

        // 校验请求顺序和参数
        const urlList = calls.map(c => c.url);
        expect(urlList).toContain('https://www.yuque.com/api/mine/common_used');
        expect(urlList).toContain('https://www.yuque.com/api/docs');
        expect(urlList).toContain('https://www.yuque.com/api/docs/convert');
        expect(urlList.some(u => u.includes('/88888/content'))).toBe(true);

        // 草稿模式不应调用 publish 接口
        expect(urlList.some(u => u.includes('/publish'))).toBe(false);
    });

    it('发布模式：额外调用 publish 接口', async () => {
        const calls = [];
        const fetchImpl = vi.fn(async (url, opts) => {
            calls.push({ url, method: (opts && opts.method) || 'GET' });
            if (url.includes('common_used')) return mockResp(MOCK_COMMON_USED);
            if (url === 'https://www.yuque.com/api/docs' && (opts && opts.method) === 'POST') return mockResp(MOCK_CREATE_DOC);
            if (url.includes('/api/docs/convert')) return mockResp(MOCK_CONVERT);
            if (url.includes('/content')) return mockResp(MOCK_SAVE);
            if (url.includes('/publish')) return mockResp({ data: {} });
            return mockResp({ ok: true });
        });

        const ctx = {
            title: '测试标题',
            content: '正文内容',
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, yuqueProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);
        expect(result.draft).toBe(false);

        // 发布模式应调用 publish 接口
        const urlList = calls.map(c => c.url);
        expect(urlList.some(u => u.includes('/88888/publish'))).toBe(true);
    });
});

// ── publish 图片转存 ────────────────────────────────────────────────────────
describe('yuqueProfile.publish — 图片转存', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Object.defineProperty(document, 'cookie', {
            get: () => 'yuque_ctoken=test_csrf_token',
            configurable: true,
        });
    });
    afterEach(() => {
        vi.useRealTimers();
        Object.defineProperty(document, 'cookie', {
            get: () => '',
            configurable: true,
        });
    });

    it('外链图片被上传并替换为语雀图床 URL（校验转换接口收到的 markdown）', async () => {
        const yuqueImgUrl = 'https://cdn.nlark.com/yuque/abc.png';
        const fetchImpl = vi.fn(async (url, opts) => {
            if (url.includes('common_used')) return mockResp(MOCK_COMMON_USED);
            if (url === 'https://www.yuque.com/api/docs' && (opts && opts.method) === 'POST') return mockResp(MOCK_CREATE_DOC);
            // 图片下载（无 credentials，直接返回 Blob）
            if (url === 'https://example.com/image.png') {
                return { ok: true, blob: async () => new Blob(['fake-image-data']) };
            }
            // 图片上传
            if (url.includes('/api/upload/attach')) {
                return mockResp({ data: { url: yuqueImgUrl, attachment_id: 'att123' } });
            }
            if (url.includes('/api/docs/convert')) return mockResp(MOCK_CONVERT);
            if (url.includes('/content')) return mockResp(MOCK_SAVE);
            return mockResp({ ok: true });
        });

        const ctx = {
            title: '图片测试',
            content: '正文 ![示例图](https://example.com/image.png) 结尾',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, yuqueProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);

        // 核心断言：图片上传接口被调用
        const uploadCall = fetchImpl.mock.calls.find(c => c[0].includes('/api/upload/attach'));
        expect(uploadCall).toBeDefined();

        // 核心断言：转换时传入的 markdown 里外链已替换为语雀图床 URL
        const convertCall = fetchImpl.mock.calls.find(c => c[0].includes('/api/docs/convert'));
        expect(convertCall).toBeDefined();
        const convertBody = JSON.parse(convertCall[1].body);
        expect(convertBody.content).toContain(yuqueImgUrl);
        expect(convertBody.content).not.toContain('example.com');
    });

    it('已在语雀图床的图片跳过上传（skipDomains）', async () => {
        const uploadMock = vi.fn();
        const fetchImpl = vi.fn(async (url, opts) => {
            if (url.includes('common_used')) return mockResp(MOCK_COMMON_USED);
            if (url === 'https://www.yuque.com/api/docs' && (opts && opts.method) === 'POST') return mockResp(MOCK_CREATE_DOC);
            if (url.includes('/api/upload/attach')) { uploadMock(url); return mockResp({ data: { url: 'x' } }); }
            if (url.includes('/api/docs/convert')) return mockResp(MOCK_CONVERT);
            if (url.includes('/content')) return mockResp(MOCK_SAVE);
            return mockResp({ ok: true });
        });

        const ctx = {
            title: '跳过测试',
            content: '正文 ![已在语雀](https://cdn.nlark.com/yuque/exist.png) 结尾',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, yuqueProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);
        // 语雀图床图片不应被上传
        expect(uploadMock).not.toHaveBeenCalled();
        expect(result.uploaded).toHaveLength(0);
    });
});

// ── publish 错误路径 ─────────────────────────────────────────────────────────
describe('yuqueProfile.publish — 错误路径', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Object.defineProperty(document, 'cookie', {
            get: () => 'yuque_ctoken=test_csrf_token',
            configurable: true,
        });
    });
    afterEach(() => {
        vi.useRealTimers();
        Object.defineProperty(document, 'cookie', {
            get: () => '',
            configurable: true,
        });
    });

    it('无 cookie → ok=false stage=auth', async () => {
        Object.defineProperty(document, 'cookie', {
            get: () => '',
            configurable: true,
        });
        const fetchImpl = vi.fn();
        const ctx = { title: 't', content: '正文', draftOnly: true, outputFormat: 'markdown', preprocessConfig: null, imageSpec: null, imageSkip: [] };
        const js = buildPublishJs(ctx, yuqueProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('auth');
    });

    it('common_used 接口失败 → ok=false stage=auth', async () => {
        const fetchImpl = vi.fn(async (url) => {
            if (url.includes('common_used')) return mockResp({ message: '未授权' }, 401);
            return mockResp({});
        });
        const ctx = { title: 't', content: '正文', draftOnly: true, outputFormat: 'markdown', preprocessConfig: null, imageSpec: null, imageSkip: [] };
        const js = buildPublishJs(ctx, yuqueProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('auth');
    });

    it('建文档接口失败 → ok=false stage=create', async () => {
        const fetchImpl = vi.fn(async (url, opts) => {
            if (url.includes('common_used')) return mockResp(MOCK_COMMON_USED);
            if (url === 'https://www.yuque.com/api/docs' && (opts && opts.method) === 'POST')
                return mockResp({ message: '创建失败' }, 500);
            return mockResp({});
        });
        const ctx = { title: 't', content: '正文', draftOnly: true, outputFormat: 'markdown', preprocessConfig: null, imageSpec: null, imageSkip: [] };
        const js = buildPublishJs(ctx, yuqueProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('create');
    });

    it('格式转换失败 → ok=false stage=convert', async () => {
        const fetchImpl = vi.fn(async (url, opts) => {
            if (url.includes('common_used')) return mockResp(MOCK_COMMON_USED);
            if (url === 'https://www.yuque.com/api/docs' && (opts && opts.method) === 'POST') return mockResp(MOCK_CREATE_DOC);
            if (url.includes('/api/docs/convert')) return mockResp({ message: '转换失败' }, 500);
            return mockResp({});
        });
        const ctx = { title: 't', content: '正文', draftOnly: true, outputFormat: 'markdown', preprocessConfig: null, imageSpec: null, imageSkip: [] };
        const js = buildPublishJs(ctx, yuqueProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('convert');
    });
});
