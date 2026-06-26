// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { selectContent, originReFromHome, buildPublishJs, publishArticle } from './publish.js';

describe('selectContent', () => {
    const htmlProfile = { outputFormat: 'html' };
    const mdProfile = { outputFormat: 'markdown' };

    it('HTML 平台拿到渲染后的 HTML', () => {
        expect(selectContent('# 标题', htmlProfile)).toContain('<h1>标题</h1>');
    });
    it('Markdown 平台拿到原始 markdown', () => {
        expect(selectContent('# 标题', mdProfile)).toBe('# 标题');
    });
});

describe('originReFromHome', () => {
    it('由 home 推断匹配本域及子域的正则', () => {
        const re = new RegExp(originReFromHome('https://zhuanlan.zhihu.com'));
        expect(re.test('https://zhuanlan.zhihu.com/write')).toBe(true);
        expect(re.test('https://www.zhihu.com/')).toBe(false); // host 不同
        expect(re.test('https://evil.com/zhuanlan.zhihu.com')).toBe(false);
    });
});

describe('buildPublishJs（单次 evaluate 源码拼装）', () => {
    it('内联 PAGE_RUNTIME + publish 源码 + 预处理/转存/发布管线', () => {
        const js = buildPublishJs({ title: 't', content: '<p>x</p>', outputFormat: 'html', preprocessConfig: {}, imageSpec: null, imageSkip: [] }, '(I) => ({ id: 1 })');
        expect(js).toContain('var PP = ');                    // 注入了页面运行时
        expect(js).toContain('PP.preprocess(content');        // html 平台会预处理
        expect(js).toContain('PP.transferImages(');           // 图片转存
        expect(js).toContain('__publish(');                   // 调平台发布
    });
});

// ── 端到端：在 jsdom 里真跑单次 evaluate 管线 ──────────────────────────────
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

describe('publishArticle（端到端，单次 evaluate）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__published; });

    it('归一→预处理→转存→发布；发布拿到处理后的正文', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true, status: 200, text: async () => JSON.stringify({ src: 'https://pic.zhimg.com/new.png' }),
        }));
        const page = evalPage(fetchImpl);

        const profile = {
            home: 'http://localhost',
            originRe: '.',                  // 测试里放过任何 URL
            outputFormat: 'html',
            preprocessConfig: { convertSectionToDiv: true },
            image: {
                spec: { url: 'https://zhuanlan.zhihu.com/api/uploaded_images', bodyType: 'form', body: { url: '{src}', source: 'article' }, responsePath: 'src', throttleMs: 0 },
                skip: ['zhimg.com'],
            },
            // 页面内发布函数：记录收到的正文，返回草稿信息
            publish: async (I) => { globalThis.__published = I; return { id: '42', url: 'https://zhuanlan.zhihu.com/p/42', draft: I.draftOnly }; },
        };

        const p = publishArticle(page, {
            title: '我的文章',
            body: '<section><h1>大标题</h1><img src="https://orig.com/a.png"></section>',
            format: 'html',
            draftOnly: true,
            profile,
        });
        await vi.runAllTimersAsync();
        const out = await p;

        // 预处理：section→div；转存：外链图换成知乎图床
        const published = globalThis.__published;
        expect(published.content).toContain('<div>');
        expect(published.content).not.toContain('<section>');
        expect(published.content).toContain('https://pic.zhimg.com/new.png');
        expect(published.content).not.toContain('orig.com');

        expect(out.id).toBe('42');
        expect(out.draft).toBe(true);
        expect(out.images.uploaded).toHaveLength(1);
        expect(page.goto).toHaveBeenCalled();      // 走了 gotoWritePage
    });

    it('缺 profile 必填项时报错', async () => {
        await expect(publishArticle({}, { title: 't', body: 'b' })).rejects.toThrow(/profile is required/);
        await expect(publishArticle({}, { title: 't', body: 'b', profile: { home: 'x' } })).rejects.toThrow(/publish must be a function/);
    });
});
