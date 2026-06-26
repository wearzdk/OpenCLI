// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';
import { evalPageRuntime } from '../_shared/article/page-runtime.js';
import { cto51Profile } from './article.js';

// ── 辅助：在 jsdom 里模拟 page.evaluate ──────────────────────────────────────
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

// ── profile 基础结构检查 ─────────────────────────────────────────────────────
describe('cto51Profile 基础结构', () => {
    it('home 指向 51CTO 博主发布页', () => {
        expect(cto51Profile.home).toBe('https://blog.51cto.com/blogger/publish');
    });

    it('outputFormat 为 markdown', () => {
        expect(cto51Profile.outputFormat).toBe('markdown');
    });

    it('publish 是函数', () => {
        expect(typeof cto51Profile.publish).toBe('function');
    });

    it('checkAuth 是函数', () => {
        expect(typeof cto51Profile.checkAuth).toBe('function');
    });

    it('image.uploadFn 是函数', () => {
        expect(typeof cto51Profile.image.uploadFn).toBe('function');
    });

    it('image.skip 包含 51cto.com 域名', () => {
        expect(cto51Profile.image.skip).toEqual(expect.arrayContaining(['s2.51cto.com', '51cto.com']));
    });
});

// ── checkAuth：登录 / 未登录解析 ────────────────────────────────────────────
describe('checkAuth（页面内）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('已登录时解析 uid 和 avatar', async () => {
        // 模拟包含 .more.user 的 HTML 页面
        const mockHtml = `
      <html><body>
        <ul class="nav">
          <li class="more user">
            <a href="https://blog.51cto.com/u_testuser123" class="avatar">
              <img src="https://avatar.51cto.com/testuser.jpg" />
            </a>
          </li>
        </ul>
        <meta name="csrf-token" content="abc123csrf" />
      </body></html>
    `;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => mockHtml,
        }));

        const js = buildCheckAuthJs(cto51Profile.checkAuth.toString());

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        try {
            // eslint-disable-next-line no-eval
            const result = await (0, eval)(js);
            // 51CTO 用户链接格式为 /u_xxx，uid 含前缀 u_
            expect(result.isAuthenticated).toBe(true);
            expect(result.userId).toBe('u_testuser123');
            expect(result.username).toBe('u_testuser123');
        } finally {
            globalThis.fetch = pf;
        }
    });

    it('未登录时返回 isAuthenticated: false', async () => {
        const mockHtml = '<html><body><p>请先登录</p></body></html>';
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => mockHtml,
        }));

        const js = buildCheckAuthJs(cto51Profile.checkAuth.toString());

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        try {
            // eslint-disable-next-line no-eval
            const result = await (0, eval)(js);
            expect(result.isAuthenticated).toBe(false);
        } finally {
            globalThis.fetch = pf;
        }
    });

    it('网络错误时返回 isAuthenticated: false 并含 error 信息', async () => {
        const fetchMock = vi.fn(async () => { throw new Error('网络超时'); });

        const js = buildCheckAuthJs(cto51Profile.checkAuth.toString());

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        try {
            // eslint-disable-next-line no-eval
            const result = await (0, eval)(js);
            expect(result.isAuthenticated).toBe(false);
            expect(result.error).toContain('网络超时');
        } finally {
            globalThis.fetch = pf;
        }
    });
});

// ── publish：草稿创建请求结构验证 ────────────────────────────────────────────
describe('publish（页面内）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.__cto51Published;
    });

    it('成功路径：POST /blogger/draft，返回 did 和草稿 URL', async () => {
        const mockHtml = '<meta name="csrf-token" content="testcsrf456" />';
        const mockDraftResp = JSON.stringify({
            status: 1,
            data: { did: 999 },
        });

        const fetchMock = vi.fn(async (url, opts) => {
            if (url && url.includes('/blogger/publish')) {
                return { ok: true, status: 200, text: async () => mockHtml };
            }
            if (url && url.includes('/blogger/draft')) {
                // 记录请求体，供断言
                globalThis.__cto51Published = { url, opts };
                return { ok: true, status: 200, text: async () => mockDraftResp };
            }
            return { ok: false, status: 404, text: async () => 'not found' };
        });

        const ctx = {
            title: '测试文章标题',
            content: '# 正文 Markdown 内容',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, cto51Profile.publish.toString(), cto51Profile.image.uploadFn.toString());

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        try {
            // eslint-disable-next-line no-eval
            const result = await (0, eval)(js);
            expect(result.ok).toBe(true);
            expect(result.id).toBe('999');
            expect(result.url).toBe('https://blog.51cto.com/blogger/draft/999');
            expect(result.draft).toBe(true);
        } finally {
            globalThis.fetch = pf;
        }

        // 验证发布请求使用了正确的 URL 和方法
        const { url, opts } = globalThis.__cto51Published;
        expect(url).toBe('https://blog.51cto.com/blogger/draft');
        expect(opts.method).toBe('POST');
        expect(opts.credentials).toBe('include');

        // 验证请求体包含标题、内容和 csrf
        const bodyStr = opts.body;
        const params = new URLSearchParams(bodyStr);
        expect(params.get('title')).toBe('测试文章标题');
        expect(params.get('content')).toBe('# 正文 Markdown 内容');
        expect(params.get('_csrf')).toBe('testcsrf456');
        expect(params.get('is_old')).toBe('0'); // Markdown 格式
    });

    it('服务端返回错误时 publish 返回 ok:false', async () => {
        const mockHtml = '<meta name="csrf-token" content="csrf" />';
        const mockErrResp = JSON.stringify({ status: 0, msg: '标题已存在' });

        const fetchMock = vi.fn(async (url) => {
            if (url && url.includes('/blogger/publish')) {
                return { ok: true, status: 200, text: async () => mockHtml };
            }
            if (url && url.includes('/blogger/draft')) {
                return { ok: true, status: 200, text: async () => mockErrResp };
            }
            return { ok: false, status: 500, text: async () => 'error' };
        });

        const ctx = {
            title: '重复标题',
            content: '正文',
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, cto51Profile.publish.toString(), cto51Profile.image.uploadFn.toString());

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        try {
            // eslint-disable-next-line no-eval
            const result = await (0, eval)(js);
            expect(result.ok).toBe(false);
            expect(result.stage).toBe('publish');
            expect(result.message).toContain('标题已存在');
        } finally {
            globalThis.fetch = pf;
        }
    });
});

// ── 图片转存：uploadFn 三步流程验证 ─────────────────────────────────────────
describe('image.uploadFn（图片转存）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('成功路径：下载 → getUploadSign → getUploadConfig → POST COS → 返回 s2.51cto.com URL', async () => {
        const PP = evalPageRuntime();

        const mockSignData = {
            code: 0,
            data: { sign: 'testsign123', allows: 'image/*', sizeLimit: 10485760, url: '', sizeLimitMessage: '' },
        };
        const mockConfigData = {
            code: 0,
            data: {
                url: 'https://cos.ap-beijing.myqcloud.com/bucket',
                fields: {
                    key: 'upload/2024/test.jpg',
                    policy: 'base64policy',
                    'x-amz-algorithm': 'AWS4-HMAC-SHA256',
                    'x-amz-signature': 'testsignature',
                    'x-amz-credential': 'testcred',
                    'X-Amz-Date': '20240101T000000Z',
                },
            },
        };

        const fetchMock = vi.fn(async (url) => {
            if (url === 'https://orig.example.com/photo.jpg') {
                // 返回假图片 blob
                return {
                    ok: true,
                    blob: async () => new Blob(['fake-image-data'], { type: 'image/jpeg' }),
                };
            }
            if (url && url.includes('getUploadSign')) {
                return { ok: true, json: async () => mockSignData };
            }
            if (url && url.includes('getUploadConfig')) {
                return { ok: true, json: async () => mockConfigData };
            }
            if (url && url.includes('cos.ap-beijing')) {
                return { ok: true, status: 204, text: async () => '' };
            }
            return { ok: false, status: 404 };
        });

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        try {
            const result = await cto51Profile.image.uploadFn('https://orig.example.com/photo.jpg', PP);
            expect(result.url).toBe('https://s2.51cto.com/upload/2024/test.jpg');
        } finally {
            globalThis.fetch = pf;
        }

        // 验证调用顺序
        const calls = fetchMock.mock.calls.map(c => c[0]);
        expect(calls[0]).toBe('https://orig.example.com/photo.jpg');       // 下载图片
        expect(calls[1]).toContain('getUploadSign');                         // 取签名
        expect(calls[2]).toContain('getUploadConfig');                       // 取凭证
        expect(calls[3]).toContain('cos.ap-beijing');                        // 上传 COS
    });

    it('getUploadSign 失败时抛错', async () => {
        const PP = evalPageRuntime();

        const fetchMock = vi.fn(async (url) => {
            if (url && url.includes('.jpg')) {
                return { ok: true, blob: async () => new Blob(['x'], { type: 'image/jpeg' }) };
            }
            if (url && url.includes('getUploadSign')) {
                return { ok: true, json: async () => ({ code: 1, msg: '签名服务不可用' }) };
            }
            return { ok: false, status: 500 };
        });

        const pf = globalThis.fetch;
        globalThis.fetch = fetchMock;
        try {
            // res.msg 优先，故抛出 '签名服务不可用'（后备文案 '获取上传签名失败' 在 msg 为空时才出现）
            await expect(
                cto51Profile.image.uploadFn('https://example.com/a.jpg', PP)
            ).rejects.toThrow('签名服务不可用');
        } finally {
            globalThis.fetch = pf;
        }
    });
});
