// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';
import { xueqiuProfile } from './article.js';

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

// ── profile 基本结构校验 ──────────────────────────────────────────────────────
describe('xueqiuProfile 结构', () => {
    it('home 指向雪球写作页', () => {
        expect(xueqiuProfile.home).toBe('https://mp.xueqiu.com/writeV2');
    });

    it('outputFormat 为 markdown', () => {
        expect(xueqiuProfile.outputFormat).toBe('markdown');
    });

    it('image.uploadFn 是函数（多步上传，非声明式 spec）', () => {
        expect(typeof xueqiuProfile.image.uploadFn).toBe('function');
    });

    it('image.skip 包含雪球自有域名（不重复转存）', () => {
        expect(xueqiuProfile.image.skip).toContain('xueqiu.com');
        expect(xueqiuProfile.image.skip).toContain('imedao.com');
    });

    it('publish 是函数', () => {
        expect(typeof xueqiuProfile.publish).toBe('function');
    });

    it('checkAuth 是函数', () => {
        expect(typeof xueqiuProfile.checkAuth).toBe('function');
    });
});

// ── checkAuth：解析 window.UOM_CURRENTUSER ───────────────────────────────────
describe('checkAuth', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('已登录：正确解析用户信息', async () => {
        const mockHtml = `
<html><body>
<script>
window.UOM_CURRENTUSER = {"currentUser":{"id":12345,"screen_name":"测试用户","photo_domain":"//photo.xueqiu.com","profile_image_url":"/abc.jpg,small"}}
</script>
</body></html>`;
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => mockHtml,
        });

        const authJs = buildCheckAuthJs(xueqiuProfile.checkAuth.toString());
        const page = evalPage(fetchImpl);
        const result = await page.evaluate(authJs);

        expect(result.isAuthenticated).toBe(true);
        expect(result.userId).toBe('12345');
        expect(result.username).toBe('测试用户');
        // avatar 拼接：https: + photo_domain + profile_image_url 第一段
        expect(result.avatar).toContain('photo.xueqiu.com');
    });

    it('未登录：页面中无 window.UOM_CURRENTUSER', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => '<html><body>请先登录</body></html>',
        });

        const authJs = buildCheckAuthJs(xueqiuProfile.checkAuth.toString());
        const page = evalPage(fetchImpl);
        const result = await page.evaluate(authJs);

        expect(result.isAuthenticated).toBe(false);
    });

    it('fetch 异常：返回 isAuthenticated:false 并带 error', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('网络错误'));

        const authJs = buildCheckAuthJs(xueqiuProfile.checkAuth.toString());
        const page = evalPage(fetchImpl);
        const result = await page.evaluate(authJs);

        expect(result.isAuthenticated).toBe(false);
        expect(result.error).toContain('网络错误');
    });

    it('UOM_CURRENTUSER 存在但 currentUser.id 为空：未登录', async () => {
        const mockHtml = `<script>
window.UOM_CURRENTUSER = {"currentUser":{"id":null,"screen_name":""}}
</script>`;
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => mockHtml,
        });

        const authJs = buildCheckAuthJs(xueqiuProfile.checkAuth.toString());
        const page = evalPage(fetchImpl);
        const result = await page.evaluate(authJs);

        expect(result.isAuthenticated).toBe(false);
    });
});

// ── publish：保存草稿请求结构 ─────────────────────────────────────────────────
describe('publish 成功路径', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__xueqiuReq; });

    it('向 save.json 发送正确的 form 参数并返回草稿信息', async () => {
        const mockId = 999001;
        const fetchImpl = vi.fn(async (url, opts) => {
            // 记录发布请求，供后续断言
            if (url && url.includes('draft/save.json')) {
                globalThis.__xueqiuReq = { url, opts };
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ id: mockId }),
                };
            }
            return { ok: true, status: 200, text: async () => '{}' };
        });

        const ctx = {
            title: '测试文章',
            content: '# 标题\n\n正文内容',
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: ['xueqiu.com', 'imedao.com'],
        };

        const js = buildPublishJs(ctx, xueqiuProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);
        expect(result.id).toBe(String(mockId));
        expect(result.url).toContain('/write/draft/' + mockId);
        expect(result.draft).toBe(true);

        // 验证请求参数
        expect(globalThis.__xueqiuReq).toBeDefined();
        const reqUrl = globalThis.__xueqiuReq.url;
        expect(reqUrl).toContain('mp.xueqiu.com/xq/statuses/draft/save.json');
        const body = globalThis.__xueqiuReq.opts.body;
        expect(body.toString()).toContain('title=%E6%B5%8B%E8%AF%95%E6%96%87%E7%AB%A0');
    });

    it('API 返回无 id 时 publish 返回 ok:false', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ error_description: '保存失败' }),
        }));

        const ctx = {
            title: '失败测试',
            content: '正文',
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };

        const js = buildPublishJs(ctx, xueqiuProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('save');
        expect(result.message).toContain('保存失败');
    });

    it('API 返回非 200 时 publish 返回 ok:false 带状态码', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: false,
            status: 401,
            text: async () => JSON.stringify({ error_description: '未登录' }),
        }));

        const ctx = {
            title: '鉴权失败测试',
            content: '正文',
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };

        const js = buildPublishJs(ctx, xueqiuProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(false);
        expect(result.status).toBe(401);
    });
});

// ── 图片转存（uploadFn）─────────────────────────────────────────────────────
describe('uploadFn 图片转存', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__xueqiuPublished; });

    it('下载图片 → multipart 上传 → 拼接完整 URL', async () => {
        const imgBlob = new Blob(['fake-image'], { type: 'image/jpeg' });
        const mockId = 888001;

        const fetchImpl = vi.fn(async (url, opts) => {
            // 图片下载
            if (url === 'https://external.com/photo.jpg') {
                return { ok: true, status: 200, blob: async () => imgBlob };
            }
            // 图片上传
            if (url && url.includes('photo/upload.json')) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ url: '//photo.xueqiu.com', filename: 'abc123.jpg' }),
                };
            }
            // 发布草稿
            if (url && url.includes('draft/save.json')) {
                globalThis.__xueqiuPublished = { url, body: opts && opts.body };
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ id: mockId }),
                };
            }
            return { ok: true, status: 200, text: async () => '{}' };
        });

        const content = '![图片](https://external.com/photo.jpg)\n\n正文';
        const ctx = {
            title: '带图文章',
            content,
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: ['xueqiu.com', 'imedao.com'],
        };

        const js = buildPublishJs(ctx, xueqiuProfile.publish.toString(), xueqiuProfile.image.uploadFn.toString());
        const page = evalPage(fetchImpl);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);
        expect(result.uploaded).toHaveLength(1);
        expect(result.uploaded[0].url).toBe('https://photo.xueqiu.com/abc123.jpg');

        // 验证发布正文中图片 URL 已被替换
        const publishedBody = globalThis.__xueqiuPublished?.body?.toString() || '';
        // content 中外链已被替换为雪球图床地址
        expect(publishedBody).not.toContain('external.com');
    });

    it('已在雪球域名的图片跳过转存', async () => {
        // 只记录是否调用了 upload 接口
        let uploadCalled = false;
        const fetchImpl = vi.fn(async (url) => {
            if (url && url.includes('photo/upload.json')) {
                uploadCalled = true;
            }
            if (url && url.includes('draft/save.json')) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ id: 777 }) };
            }
            return { ok: true, status: 200, text: async () => '{}' };
        });

        const content = '![图片](https://xueqiu.com/already-hosted.jpg)\n\n正文';
        const ctx = {
            title: '已托管图片测试',
            content,
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: ['xueqiu.com', 'imedao.com'],
        };

        const js = buildPublishJs(ctx, xueqiuProfile.publish.toString(), xueqiuProfile.image.uploadFn.toString());
        const page = evalPage(fetchImpl);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        await p;

        expect(uploadCalled).toBe(false);
    });
});

// ── markdown → 雪球简化 HTML 渲染（在 publish 内部）───────────────────────────
describe('publish 内部 markdown 转 HTML', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__xueqiuContent; });

    it('标题统一转为 h4，加粗转 b，斜体转 i', async () => {
        const mockId = 666001;
        const fetchImpl = vi.fn(async (url, opts) => {
            if (url && url.includes('draft/save.json')) {
                // 解析 URLSearchParams 拿到 text 字段
                const params = new URLSearchParams(opts && opts.body ? opts.body.toString() : '');
                globalThis.__xueqiuContent = params.get('text');
                return { ok: true, status: 200, text: async () => JSON.stringify({ id: mockId }) };
            }
            return { ok: true, status: 200, text: async () => '{}' };
        });

        const markdown = '# 一级标题\n\n**加粗文字** 和 *斜体*\n\n普通段落';
        const ctx = {
            title: '渲染测试',
            content: markdown,
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };

        const js = buildPublishJs(ctx, xueqiuProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        await p;

        const html = globalThis.__xueqiuContent || '';
        // 标题变 h4
        expect(html).toContain('<h4>一级标题</h4>');
        // 加粗变 b
        expect(html).toContain('<b>加粗文字</b>');
        // 斜体变 i
        expect(html).toContain('<i>斜体</i>');
        // 普通段落有 p
        expect(html).toContain('<p>');
    });

    it('分割线被移除（hr → 空）', async () => {
        const mockId = 666002;
        const fetchImpl = vi.fn(async (url, opts) => {
            if (url && url.includes('draft/save.json')) {
                const params = new URLSearchParams(opts && opts.body ? opts.body.toString() : '');
                globalThis.__xueqiuContent = params.get('text');
                return { ok: true, status: 200, text: async () => JSON.stringify({ id: mockId }) };
            }
            return { ok: true, status: 200, text: async () => '{}' };
        });

        const markdown = '段落一\n\n---\n\n段落二';
        const ctx = {
            title: '分割线测试',
            content: markdown,
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };

        const js = buildPublishJs(ctx, xueqiuProfile.publish.toString(), null);
        const page = evalPage(fetchImpl);
        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        await p;

        const html = globalThis.__xueqiuContent || '';
        expect(html).not.toContain('<hr');
        expect(html).toContain('段落一');
        expect(html).toContain('段落二');
    });
});
