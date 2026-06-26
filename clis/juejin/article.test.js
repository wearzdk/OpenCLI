// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';
import { juejinProfile } from './article.js';

// ── 测试辅助：在 jsdom 里运行单次 evaluate ────────────────────────────────
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

// ── profile 声明结构测试 ──────────────────────────────────────────────────
describe('juejin article profile 声明', () => {
    it('outputFormat 为 markdown（掘金原生吃 Markdown）', () => {
        expect(juejinProfile.outputFormat).toBe('markdown');
    });

    it('home 指向掘金主站', () => {
        expect(juejinProfile.home).toBe('https://juejin.cn');
    });

    it('image.skip 包含掘金图床域名', () => {
        const skip = juejinProfile.image.skip;
        expect(skip).toContain('juejin.cn');
        expect(skip).toContain('byteimg.com');
    });

    it('image.uploadFn 是函数（ImageX 多步上传）', () => {
        expect(typeof juejinProfile.image.uploadFn).toBe('function');
    });

    it('publish 是函数', () => {
        expect(typeof juejinProfile.publish).toBe('function');
    });

    it('checkAuth 是函数', () => {
        expect(typeof juejinProfile.checkAuth).toBe('function');
    });

    it('publish 函数体引用正确的 API 端点', () => {
        const src = juejinProfile.publish.toString();
        expect(src).toContain('article_draft/create');
        expect(src).toContain('x-secsdk-csrf-token');
        expect(src).toContain('mark_content');
    });

    it('uploadFn 函数体包含 ImageX 关键步骤', () => {
        const src = juejinProfile.image.uploadFn.toString();
        expect(src).toContain('gen_token');
        expect(src).toContain('ApplyImageUpload');
        expect(src).toContain('CommitImageUpload');
        expect(src).toContain('get_img_url');
        expect(src).toContain('crc32');
        expect(src).toContain('crypto.subtle');
    });
});

// ── checkAuth：已登录/未登录解析 ────────────────────────────────────────
describe('juejin checkAuth（页面内函数）', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    async function runCheckAuth(fetchImpl) {
        const js = buildCheckAuthJs(juejinProfile.checkAuth.toString());
        const pf = globalThis.fetch;
        globalThis.fetch = fetchImpl;
        try {
            // eslint-disable-next-line no-eval
            return await (0, eval)(js);
        } finally {
            globalThis.fetch = pf;
        }
    }

    it('已登录：正确解析 user_id / user_name / avatar_large', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                data: {
                    user_id: '123456789',
                    user_name: '测试用户',
                    avatar_large: 'https://p1.juejin.cn/avatar.png',
                },
            }),
        });

        const result = await runCheckAuth(mockFetch);

        expect(result.isAuthenticated).toBe(true);
        expect(result.userId).toBe('123456789');
        expect(result.username).toBe('测试用户');
        expect(result.avatar).toBe('https://p1.juejin.cn/avatar.png');

        // 验证调用了正确的接口
        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.juejin.cn/user_api/v1/user/get',
            expect.objectContaining({ method: 'GET', credentials: 'include' })
        );
    });

    it('未登录：data.user_id 为空时返回 isAuthenticated:false', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ data: {} }),
        });

        const result = await runCheckAuth(mockFetch);

        expect(result.isAuthenticated).toBe(false);
    });

    it('接口异常：catch 后返回 isAuthenticated:false', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));

        const result = await runCheckAuth(mockFetch);

        expect(result.isAuthenticated).toBe(false);
        expect(result.error).toContain('network error');
    });

    it('响应无 data 字段：返回 isAuthenticated:false', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            json: async () => ({ err_no: 1, err_msg: '未授权' }),
        });

        const result = await runCheckAuth(mockFetch);

        expect(result.isAuthenticated).toBe(false);
    });
});

// ── publish：成功路径（页面内函数）──────────────────────────────────────
describe('juejin publish（页面内函数）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    async function runPublish(fetchImpl, input) {
        const I = Object.assign({ title: '测试文章', content: '# 标题\n\n内容', draftOnly: true }, input);
        const js = '(async () => {\n'
            + 'const __publish = (' + juejinProfile.publish.toString() + ');\n'
            + 'const PP = {};\n'
            + 'return await __publish(' + JSON.stringify(I) + ', PP);\n'
            + '})()';

        const pf = globalThis.fetch;
        globalThis.fetch = fetchImpl;
        try {
            // eslint-disable-next-line no-eval
            return await (0, eval)(js);
        } finally {
            globalThis.fetch = pf;
        }
    }

    it('成功：取 CSRF token → 创建草稿 → 返回 ok:true 和草稿 URL', async () => {
        const mockFetch = vi.fn()
            // 第一次：HEAD 取 CSRF token
            .mockResolvedValueOnce({
                ok: true,
                headers: { get: (h) => h === 'x-ware-csrf-token' ? '0,test-csrf-token,86370000,success,sess123' : null },
            })
            // 第二次：POST 创建草稿
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ err_no: 0, data: { id: '7999888777666555444' } }),
            });

        const result = await runPublish(mockFetch);

        expect(result.ok).toBe(true);
        expect(result.draft).toBe(true);
        expect(result.id).toBe('7999888777666555444');
        expect(result.url).toBe('https://juejin.cn/editor/drafts/7999888777666555444');

        // 验证 CSRF 请求
        const headCall = mockFetch.mock.calls[0];
        expect(headCall[0]).toContain('sys/token');
        expect(headCall[1].method).toBe('HEAD');
        expect(headCall[1].headers['x-secsdk-csrf-request']).toBe('1');

        // 验证草稿创建请求
        const postCall = mockFetch.mock.calls[1];
        expect(postCall[0]).toContain('article_draft/create');
        expect(postCall[1].method).toBe('POST');
        const body = JSON.parse(postCall[1].body);
        expect(body.title).toBe('测试文章');
        expect(body.mark_content).toBe('# 标题\n\n内容');
        expect(body.edit_type).toBe(10);
        expect(body.html_content).toBe('deprecated');
        expect(postCall[1].headers['x-secsdk-csrf-token']).toBe('test-csrf-token');
    });

    it('创建草稿 HTTP 失败：返回 ok:false 含 stage 和 status', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                headers: { get: () => null }, // 无 CSRF
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                text: async () => '{"err_no":10012,"err_msg":"未登录"}',
            });

        const result = await runPublish(mockFetch);

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('create');
        expect(result.status).toBe(401);
    });

    it('业务错误（err_no 非零）：返回 ok:false 含错误信息', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                headers: { get: () => null },
            })
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ err_no: 10003, err_msg: '内容违规' }),
            });

        const result = await runPublish(mockFetch);

        expect(result.ok).toBe(false);
        expect(result.message).toContain('内容违规');
    });

    it('正文通过 mark_content 字段传入，标题通过 title 字段传入', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                headers: { get: () => '0,csrf-abc,0,success,s1' },
            })
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ err_no: 0, data: { id: '1234567890123456789' } }),
            });

        await runPublish(mockFetch, { title: '我的掘金文章', content: '**加粗内容**', draftOnly: true });

        const body = JSON.parse(mockFetch.mock.calls[1][1].body);
        expect(body.title).toBe('我的掘金文章');
        expect(body.mark_content).toBe('**加粗内容**');
    });
});

// ── buildPublishJs：markdown 平台不跑预处理，跑 processImagesWith ─────────
describe('buildPublishJs 管线结构（markdown 平台）', () => {
    it('outputFormat=markdown：管线有 html 条件守卫，使用 processImagesWith（uploadFn 路径）', () => {
        const js = buildPublishJs(
            {
                title: 't',
                content: '# 测试',
                outputFormat: 'markdown',
                preprocessConfig: null,
                imageSpec: null,
                imageSkip: [],
            },
            '(I) => ({ id: "1", url: "https://juejin.cn/editor/drafts/1", draft: true })',
            juejinProfile.image.uploadFn.toString()
        );

        // 管线里的预处理有 outputFormat=html 条件守卫（markdown 时不执行）
        expect(js).toContain('I.outputFormat === "html"');
        // 有 uploadFn → 走 processImagesWith
        expect(js).toContain('PP.processImagesWith(');
        // 调平台发布
        expect(js).toContain('__publish(');
        // 注入了页面运行时
        expect(js).toContain('var PP = ');
    });

    it('buildPublishJs 会把 uploadFn 注入进 evaluate 源码', () => {
        const js = buildPublishJs(
            { title: 't', content: 'c', outputFormat: 'markdown', preprocessConfig: null, imageSpec: null, imageSkip: [] },
            '(I) => ({ id: "x", url: "u", draft: true })',
            juejinProfile.image.uploadFn.toString()
        );

        // uploadFn 里的关键常量和步骤应出现在拼出来的代码里
        expect(js).toContain('ApplyImageUpload');
        expect(js).toContain('CommitImageUpload');
        expect(js).toContain('crc32');
    });
});
