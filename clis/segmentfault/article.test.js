// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';
import { segmentfaultProfile } from './article.js';
import { authProfile } from './whoami.js';

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
describe('segmentfault article profile 声明', () => {
    it('outputFormat 为 markdown（思否原生吃 Markdown）', () => {
        expect(segmentfaultProfile.outputFormat).toBe('markdown');
    });

    it('home 指向思否写作页', () => {
        expect(segmentfaultProfile.home).toBe('https://segmentfault.com/write');
    });

    it('image.skip 包含思否图床域名', () => {
        const skip = segmentfaultProfile.image.skip;
        expect(skip).toContain('image-static.segmentfault.com');
        expect(skip).toContain('avatar-static.segmentfault.com');
    });

    it('image.uploadFn 是函数（需先取 token 再上传）', () => {
        expect(typeof segmentfaultProfile.image.uploadFn).toBe('function');
    });

    it('publish 是函数', () => {
        expect(typeof segmentfaultProfile.publish).toBe('function');
    });

    it('publish 函数体引用正确的 API 端点', () => {
        const src = segmentfaultProfile.publish.toString();
        expect(src).toContain('segmentfault.com/gateway/draft');
        expect(src).toContain('segmentfault.com/write');
        expect(src).toContain('Token');
    });

    it('uploadFn 函数体包含 token 提取和图片上传步骤', () => {
        const src = segmentfaultProfile.image.uploadFn.toString();
        expect(src).toContain('segmentfault.com/write');
        expect(src).toContain('Token');
        expect(src).toContain('gateway/image');
        expect(src).toContain('FormData');
    });

    it('markdown 平台不需要 preprocessConfig', () => {
        expect(segmentfaultProfile.preprocessConfig).toBeUndefined();
    });
});

// ── checkAuth：已登录/未登录解析 ────────────────────────────────────────
describe('segmentfault checkAuth（页面内函数）', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    async function runCheckAuth(fetchImpl) {
        const js = buildCheckAuthJs(authProfile.checkAuth.toString());
        const pf = globalThis.fetch;
        globalThis.fetch = fetchImpl;
        try {
            // eslint-disable-next-line no-eval
            return await (0, eval)(js);
        } finally {
            globalThis.fetch = pf;
        }
    }

    it('已登录：从 HTML 解析 user_id 和头像', async () => {
        const html = `<!DOCTYPE html>
<html>
<head><title>设置</title></head>
<body>
  <a href="/u/testuser123">我的主页</a>
  <img src="https://avatar-static.segmentfault.com/123/456/avatar.png" />
</body>
</html>`;

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => html,
        });

        const result = await runCheckAuth(mockFetch);

        expect(result.isAuthenticated).toBe(true);
        expect(result.userId).toBe('testuser123');
        expect(result.username).toBe('testuser123');
        expect(result.avatar).toBe('https://avatar-static.segmentfault.com/123/456/avatar.png');

        expect(mockFetch).toHaveBeenCalledWith(
            'https://segmentfault.com/user/settings',
            expect.objectContaining({ credentials: 'include' })
        );
    });

    it('未登录：HTML 中无 /u/ 链接时返回 isAuthenticated:false', async () => {
        const html = `<!DOCTYPE html>
<html><body><p>请登录</p></body></html>`;

        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            text: async () => html,
        });

        const result = await runCheckAuth(mockFetch);

        expect(result.isAuthenticated).toBe(false);
        expect(result.error).toBeTruthy();
    });

    it('接口异常：catch 后返回 isAuthenticated:false', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));

        const result = await runCheckAuth(mockFetch);

        expect(result.isAuthenticated).toBe(false);
        expect(result.error).toContain('network error');
    });

    it('有用户链接但无头像：avatar 为空字符串', async () => {
        const html = `<body><a href="/u/noavataruser">主页</a></body>`;

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => html,
        });

        const result = await runCheckAuth(mockFetch);

        expect(result.isAuthenticated).toBe(true);
        expect(result.userId).toBe('noavataruser');
        expect(result.avatar).toBe('');
    });
});

// ── publish：成功路径（页面内函数）──────────────────────────────────────
describe('segmentfault publish（页面内函数）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    // 在 jsdom 里直接跑 publish 函数（不走完整 evaluate 管线）
    async function runPublish(fetchImpl, input) {
        const I = Object.assign({ title: '测试文章', content: '# 标题\n\n内容', draftOnly: true }, input);
        const js = '(async () => {\n'
            + 'const __publish = (' + segmentfaultProfile.publish.toString() + ');\n'
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

    // 构造含 token 的写作页 HTML（新版格式：JSON 内嵌属性键带引号）
    // 思否页面中 serverData 作为 JSON 对象的键出现，格式：serverData":{"Token":"xxx"
    const writePageHtml = '<html><head><script>var __data = {"serverData":{"Token":"sf-test-token-abc123"}};</script></head><body><main id="write"></main></body></html>';

    // 构造旧版格式写作页 HTML（g_initialProps 赋值格式，结尾要精确匹配 ;\n\t</script>）
    const writePageHtmlLegacy = '<html><head><script>\n\t\twindow.g_initialProps = {"global":{"sessionInfo":{"key":"sf-legacy-token-xyz"}}};\n\t</script></head><body></body></html>';

    it('成功（新版 token）：取 token → 建草稿 → 返回 ok:true 和草稿 URL', async () => {
        const mockFetch = vi.fn()
            // 第一次：GET /write 取 token
            .mockResolvedValueOnce({
                ok: true,
                text: async () => writePageHtml,
            })
            // 第二次：POST /gateway/draft 建草稿
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ id: '88888', slug: 'test-article' }),
            });

        const result = await runPublish(mockFetch);

        expect(result.ok).toBe(true);
        expect(result.draft).toBe(true);
        expect(result.id).toBe('88888');
        expect(result.url).toBe('https://segmentfault.com/write?draftId=88888');

        // 验证 token 请求
        const getCall = mockFetch.mock.calls[0];
        expect(getCall[0]).toBe('https://segmentfault.com/write');
        expect(getCall[1]).toMatchObject({ credentials: 'include' });

        // 验证草稿创建请求
        const postCall = mockFetch.mock.calls[1];
        expect(postCall[0]).toBe('https://segmentfault.com/gateway/draft');
        expect(postCall[1].method).toBe('POST');
        const body = JSON.parse(postCall[1].body);
        expect(body.title).toBe('测试文章');
        expect(body.text).toBe('# 标题\n\n内容');
        expect(body.type).toBe('article');
        expect(postCall[1].headers.token).toBe('sf-test-token-abc123');
    });

    it('成功（旧版 g_initialProps token）：正确取到 token', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                text: async () => writePageHtmlLegacy,
            })
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ id: '77777' }),
            });

        const result = await runPublish(mockFetch);

        expect(result.ok).toBe(true);
        expect(result.id).toBe('77777');
        const postCall = mockFetch.mock.calls[1];
        expect(postCall[1].headers.token).toBe('sf-legacy-token-xyz');
    });

    it('响应为数组格式 [0, {id}]：正确解析', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                text: async () => writePageHtml,
            })
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify([0, { id: '99999' }]),
            });

        const result = await runPublish(mockFetch);

        expect(result.ok).toBe(true);
        expect(result.id).toBe('99999');
        expect(result.url).toBe('https://segmentfault.com/write?draftId=99999');
    });

    it('响应为数组错误格式 [1, "错误信息"]：返回 ok:false', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                text: async () => writePageHtml,
            })
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify([1, '内容违规']),
            });

        const result = await runPublish(mockFetch);

        expect(result.ok).toBe(false);
        expect(result.message).toBe('内容违规');
    });

    it('响应 Unauthorized：返回 ok:false（stage=publish）', async () => {
        const mockFetch = vi.fn()
            // 第一次：GET /write 取 token（成功）
            .mockResolvedValueOnce({
                ok: true,
                text: async () => writePageHtml,
            })
            // 第二次：POST /gateway/draft 返回 Unauthorized
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => 'Unauthorized',
            });

        const result = await runPublish(mockFetch);

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('publish');
        expect(result.message).toContain('未授权');
    });

    it('获取 token 失败（HTML 无匹配）：返回 ok:false', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                text: async () => '<html><body>无 token</body></html>',
            });

        const result = await runPublish(mockFetch);

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('token');
        expect(result.message).toContain('token');
    });

    it('title 和 content 正确传入草稿请求体', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                text: async () => writePageHtml,
            })
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ id: '11111' }),
            });

        await runPublish(mockFetch, { title: '我的思否文章', content: '**加粗内容**', draftOnly: true });

        const body = JSON.parse(mockFetch.mock.calls[1][1].body);
        expect(body.title).toBe('我的思否文章');
        expect(body.text).toBe('**加粗内容**');
    });
});

// ── 图片转存：uploadFn 正确从写作页取 token 再上传 ────────────────────
describe('segmentfault uploadFn（页面内函数）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    // 同 publish 测试的格式：JSON 键带引号
    const writePageHtml = '<html><head><script>var __data = {"serverData":{"Token":"img-token-xyz"}};</script></head><body></body></html>';

    async function runUploadFn(fetchImpl, src) {
        const js = '(async () => {\n'
            + 'const __upload = (' + segmentfaultProfile.image.uploadFn.toString() + ');\n'
            + 'const PP = {};\n'
            + 'return await __upload(' + JSON.stringify(src) + ', PP);\n'
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

    it('成功（新版返回格式 result 字段）：正确返回图床 URL', async () => {
        const mockFetch = vi.fn()
            // 第一次：GET /write 取 token
            .mockResolvedValueOnce({
                ok: true,
                text: async () => writePageHtml,
            })
            // 第二次：下载图片字节
            .mockResolvedValueOnce({
                ok: true,
                blob: async () => new Blob(['image bytes'], { type: 'image/png' }),
            })
            // 第三次：上传到图床
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ url: '/img/abc.png', result: 'https://image-static.segmentfault.com/abc.png' }),
            });

        const result = await runUploadFn(mockFetch, 'https://example.com/image.png');

        expect(result.url).toBe('https://image-static.segmentfault.com/abc.png');

        // 验证上传请求的 token header
        const uploadCall = mockFetch.mock.calls[2];
        expect(uploadCall[0]).toBe('https://segmentfault.com/gateway/image');
        expect(uploadCall[1].method).toBe('POST');
        expect(uploadCall[1].headers.token).toBe('img-token-xyz');
    });

    it('成功（旧版数组返回 [0, url, id]）：正确返回图床 URL', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                text: async () => writePageHtml,
            })
            .mockResolvedValueOnce({
                ok: true,
                blob: async () => new Blob(['img'], { type: 'image/jpeg' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify([0, 'https://image-static.segmentfault.com/old/img.jpg', 'img-id']),
            });

        const result = await runUploadFn(mockFetch, 'https://example.com/old.jpg');

        expect(result.url).toBe('https://image-static.segmentfault.com/old/img.jpg');
    });

    it('旧版数组返回 [1, "错误"]：抛错', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                text: async () => writePageHtml,
            })
            .mockResolvedValueOnce({
                ok: true,
                blob: async () => new Blob(['img'], { type: 'image/png' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify([1, '图片过大']),
            });

        await expect(runUploadFn(mockFetch, 'https://example.com/big.png')).rejects.toThrow('图片过大');
    });

    it('token 获取失败：抛出 session token 失败错误', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                text: async () => '<html><body>无 token</body></html>',
            });

        await expect(runUploadFn(mockFetch, 'https://example.com/img.png')).rejects.toThrow('session token');
    });
});

// ── buildPublishJs：markdown 平台管线结构 ────────────────────────────────
describe('buildPublishJs 管线结构（markdown 平台）', () => {
    it('outputFormat=markdown：有 html 条件守卫，使用 processImagesWith（uploadFn 路径）', () => {
        const js = buildPublishJs(
            {
                title: 't',
                content: '# 测试',
                outputFormat: 'markdown',
                preprocessConfig: null,
                imageSpec: null,
                imageSkip: [],
            },
            '(I) => ({ id: "1", url: "https://segmentfault.com/write?draftId=1", draft: true })',
            segmentfaultProfile.image.uploadFn.toString()
        );

        // 预处理有 outputFormat=html 条件守卫（markdown 时不执行）
        expect(js).toContain('I.outputFormat === "html"');
        // 有 uploadFn → 走 processImagesWith
        expect(js).toContain('PP.processImagesWith(');
        // 调平台发布
        expect(js).toContain('__publish(');
        // 注入了页面运行时
        expect(js).toContain('var PP = ');
    });

    it('buildPublishJs 把 uploadFn 注入进 evaluate 源码', () => {
        const js = buildPublishJs(
            { title: 't', content: 'c', outputFormat: 'markdown', preprocessConfig: null, imageSpec: null, imageSkip: [] },
            '(I) => ({ id: "x", url: "u", draft: true })',
            segmentfaultProfile.image.uploadFn.toString()
        );

        // uploadFn 里的关键端点应出现在拼出来的代码里
        expect(js).toContain('gateway/image');
        expect(js).toContain('Token');
        expect(js).toContain('FormData');
    });
});
