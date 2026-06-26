// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPublishJs } from '../_shared/article/publish.js';
import { buildCheckAuthJs } from '../_shared/article/auth.js';
import { weixinProfile, weixinAuthProfile } from './article.js';

// ── 辅助：在 jsdom 内执行单次 evaluate（模拟 page.evaluate）──────────────────
function evalPage(fetchImpl) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: async (js) => {
            const orig = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            try {
                // eslint-disable-next-line no-eval
                return await (0, eval)(js);
            } finally {
                globalThis.fetch = orig;
            }
        },
    };
}

// ── 模拟微信首页 HTML 片段（包含 token/ticket/nick_name 等字段）──────────────
function makeMpHtml({ token = 'T12345', nickName = '测试公众号', userName = 'gh_abc123', ticket = 'TICKET_XYZ', svrTime = '1700000000' } = {}) {
    return `
<html><head></head><body>
<script>
wx.config({
  data: {
    t: "${token}",
    time: "${svrTime}",
    ticket: "${ticket}",
    user_name: "${userName}",
    nick_name: "${nickName}",
  }
});
</script>
<img class="weui-desktop-account__thumb" src="https://mmbiz.qpic.cn/mmbiz/avatar.png">
</body></html>
`;
}

// ── 测试：profile.checkAuth 解析 ─────────────────────────────────────────────
describe('weixinProfile.checkAuth（登录检测移植自 Wechatsync）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('已登录时解析 token/nickName/userId/avatar', async () => {
        const html = makeMpHtml({ token: 'T99', nickName: '我的号', userName: 'gh_test' });
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => html,
        });
        const js = buildCheckAuthJs(weixinAuthProfile.checkAuth.toString());
        const page = evalPage(fetchMock);
        const r = await page.evaluate(js);

        expect(r.isAuthenticated).toBe(true);
        expect(r.username).toBe('我的号');
        expect(r.userId).toBe('gh_test');
        expect(r.avatar).toBe('https://mmbiz.qpic.cn/mmbiz/avatar.png');
    });

    it('未登录（页面无 token）时返回 isAuthenticated: false', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => '<html><body>请登录</body></html>',
        });
        const js = buildCheckAuthJs(weixinAuthProfile.checkAuth.toString());
        const page = evalPage(fetchMock);
        const r = await page.evaluate(js);

        expect(r.isAuthenticated).toBe(false);
    });
});

// ── 测试：preprocessConfig 存在且字段正确 ───────────────────────────────────
describe('weixinProfile.preprocessConfig', () => {
    it('包含 removeLinks 和 compactHtml', () => {
        expect(weixinProfile.preprocessConfig).toBeDefined();
        expect(weixinProfile.preprocessConfig.removeLinks).toBe(true);
        expect(weixinProfile.preprocessConfig.compactHtml).toBe(true);
    });

    it('keepLinkDomains 包含 mp.weixin.qq.com', () => {
        expect(weixinProfile.preprocessConfig.keepLinkDomains).toContain('mp.weixin.qq.com');
    });

    it('outputFormat 为 html', () => {
        expect(weixinProfile.outputFormat).toBe('html');
    });
});

// ── 测试：profile.publish 成功路径 ──────────────────────────────────────────
describe('weixinProfile.publish（发布函数，页面内执行）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__weixinPublished; });

    it('发布成功：读 token→调 operate_appmsg→返回草稿 URL', async () => {
        // 模拟微信首页 HTML（含 token）注入到 jsdom
        document.documentElement.innerHTML = makeMpHtml({ token: 'TOK888', userName: 'gh_abc' });

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ appMsgId: '9527', ret: 0, base_resp: { ret: 0 } }),
            json: async () => ({ appMsgId: '9527', ret: 0, base_resp: { ret: 0 } }),
        });

        const ctx = {
            title: '测试标题',
            content: '<p>正文内容</p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: weixinProfile.preprocessConfig,
            imageSpec: null,
            imageSkip: weixinProfile.image.skip,
        };
        const js = buildPublishJs(ctx, weixinProfile.publish.toString(), weixinProfile.image.uploadFn.toString());
        const page = evalPage(fetchMock);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);
        expect(result.id).toBe('9527');
        expect(result.url).toContain('appmsgid=9527');
        expect(result.draft).toBe(true);

        // 确认请求包含 operate_appmsg 路径
        const calls = fetchMock.mock.calls;
        const publishCall = calls.find(([url]) => String(url).includes('operate_appmsg'));
        expect(publishCall).toBeDefined();
        expect(publishCall[0]).toContain('TOK888');
    });

    it('页面无 token 时返回 ok:false（auth 阶段失败）', async () => {
        // 注入无 token 的页面
        document.documentElement.innerHTML = '<html><body>请登录</body></html>';

        const fetchMock = vi.fn();
        const ctx = {
            title: '标题',
            content: '<p>内容</p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: weixinProfile.preprocessConfig,
            imageSpec: null,
            imageSkip: weixinProfile.image.skip,
        };
        const js = buildPublishJs(ctx, weixinProfile.publish.toString(), weixinProfile.image.uploadFn.toString());
        const page = evalPage(fetchMock);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('auth');
        expect(result.message).toContain('token');
    });

    it('operate_appmsg 返回无 appMsgId 时返回 ok:false（publish 阶段失败）', async () => {
        document.documentElement.innerHTML = makeMpHtml({ token: 'TOKBAD' });

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ret: -1, base_resp: { ret: -1, err_msg: 'system error' } }),
            json: async () => ({ ret: -1, base_resp: { ret: -1 } }),
        });

        const ctx = {
            title: '失败标题',
            content: '<p>内容</p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: weixinProfile.preprocessConfig,
            imageSpec: null,
            imageSkip: weixinProfile.image.skip,
        };
        const js = buildPublishJs(ctx, weixinProfile.publish.toString(), weixinProfile.image.uploadFn.toString());
        const page = evalPage(fetchMock);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('publish');
    });
});

// ── 测试：图片转存 uploadFn ──────────────────────────────────────────────────
describe('weixinProfile.image.uploadFn（图片转存）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('skip 域名列表包含 mmbiz.qpic.cn 和 mmbiz.qlogo.cn', () => {
        const skip = weixinProfile.image.skip;
        expect(skip).toContain('mmbiz.qpic.cn');
        expect(skip).toContain('mmbiz.qlogo.cn');
    });

    it('uploadFn 成功：下载图片 → 上传 → 返回 cdn_url', async () => {
        // 注入含 token 的页面
        document.documentElement.innerHTML = makeMpHtml({
            token: 'TOKIMG',
            ticket: 'TKT_IMG',
            userName: 'gh_img',
            svrTime: '1700001000',
        });

        const imageBlob = new Blob(['fake-image-bytes'], { type: 'image/jpeg' });
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({ ok: true, blob: async () => imageBlob })     // 下载图片
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ cdn_url: 'https://mmbiz.qpic.cn/test/uploaded.jpg', base_resp: { err_msg: 'ok' } }),
            }); // 上传接口

        // 通过 buildPublishJs 的 processImagesWith 路径测试
        const ctx = {
            title: '图片测试',
            content: '<p><img src="https://external.com/img/test.jpg"></p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: weixinProfile.preprocessConfig,
            imageSpec: null,
            imageSkip: weixinProfile.image.skip,
        };
        const publishFn = async (I) => {
            return { id: 'img-test-id', url: 'https://mp.weixin.qq.com/draft', draft: true };
        };
        const js = buildPublishJs(ctx, publishFn.toString(), weixinProfile.image.uploadFn.toString());
        const page = evalPage(fetchMock);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);
        expect(result.uploaded).toHaveLength(1);
        expect(result.uploaded[0].url).toBe('https://mmbiz.qpic.cn/test/uploaded.jpg');
        // 上传请求应含 token
        const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).includes('filetransfer'));
        expect(uploadCall).toBeDefined();
        expect(uploadCall[0]).toContain('TOKIMG');
        expect(uploadCall[0]).toContain('TKT_IMG');
    });

    it('已在微信 CDN 的图片（mmbiz.qpic.cn）不重传', async () => {
        document.documentElement.innerHTML = makeMpHtml({ token: 'TOKSKIP' });

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ appMsgId: 'skip-id', base_resp: { ret: 0 } }),
            text: async () => JSON.stringify({ appMsgId: 'skip-id', base_resp: { ret: 0 } }),
        });

        const ctx = {
            title: '跳过已有图',
            content: '<p><img src="https://mmbiz.qpic.cn/already/here.jpg"></p>',
            draftOnly: true,
            outputFormat: 'html',
            preprocessConfig: weixinProfile.preprocessConfig,
            imageSpec: null,
            imageSkip: weixinProfile.image.skip,
        };
        const publishFn = async (I) => ({ id: 'skip-id', url: 'https://mp.weixin.qq.com/draft', draft: true });
        const js = buildPublishJs(ctx, publishFn.toString(), weixinProfile.image.uploadFn.toString());
        const page = evalPage(fetchMock);

        const p = page.evaluate(js);
        await vi.runAllTimersAsync();
        const result = await p;

        expect(result.ok).toBe(true);
        // 没有图片被上传（skip 命中）
        expect(result.uploaded).toHaveLength(0);
        // 没有请求到 filetransfer
        const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).includes('filetransfer'));
        expect(uploadCall).toBeUndefined();
    });
});

// ── 测试：weixinAuthProfile 字段 ─────────────────────────────────────────────
describe('weixinAuthProfile', () => {
    it('home 为 https://mp.weixin.qq.com', () => {
        expect(weixinAuthProfile.home).toBe('https://mp.weixin.qq.com');
    });

    it('checkAuth 是函数', () => {
        expect(typeof weixinAuthProfile.checkAuth).toBe('function');
    });
});
