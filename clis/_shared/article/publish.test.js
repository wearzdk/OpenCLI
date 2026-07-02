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

// ── 封面统一转存（publishParams.cover 走平台图片管道）──────────────────────
describe('publishArticle：封面统一转存', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); delete globalThis.__published; });

    const makeProfile = (fetchOverrides = {}) => ({
        home: 'http://localhost',
        originRe: '.',
        outputFormat: 'html',
        image: {
            spec: { url: 'https://up.example.com/upload', bodyType: 'form', body: { url: '{src}' }, responsePath: 'src', throttleMs: 0 },
            skip: ['cdn.example.com'],
        },
        publish: async (I) => { globalThis.__published = I; return { id: '1', url: 'u', draft: true }; },
        ...fetchOverrides,
    });

    it('外链封面经平台管道转存，publish 收到平台图床 URL，并计入转存统计', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true, status: 200, text: async () => JSON.stringify({ src: 'https://cdn.example.com/cover-new.png' }),
        }));
        const p = publishArticle(evalPage(fetchImpl), {
            title: 't', body: '<p>正文无图</p>', format: 'html', draftOnly: true,
            profile: makeProfile(),
            publishParams: { cover: 'https://other.com/cover.png' },
        });
        await vi.runAllTimersAsync();
        const out = await p;
        expect(globalThis.__published.params.cover).toBe('https://cdn.example.com/cover-new.png');
        expect(out.images.uploaded).toHaveLength(1);
    });

    it('封面已在平台图床（skip 命中）则原样保留、不再上传', async () => {
        const fetchImpl = vi.fn(async () => { throw new Error('不应发起上传'); });
        const p = publishArticle(evalPage(fetchImpl), {
            title: 't', body: '<p>正文</p>', format: 'html', draftOnly: true,
            profile: makeProfile(),
            publishParams: { cover: 'https://cdn.example.com/already.png' },
        });
        await vi.runAllTimersAsync();
        const out = await p;
        expect(globalThis.__published.params.cover).toBe('https://cdn.example.com/already.png');
        expect(out.images.uploaded).toHaveLength(0);
    });

    it('封面转存失败 → 硬失败（stage=cover），不静默丢封面', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
        const p = publishArticle(evalPage(fetchImpl), {
            title: 't', body: '<p>正文</p>', format: 'html', draftOnly: true,
            profile: makeProfile(),
            publishParams: { cover: 'https://other.com/cover.png' },
        });
        const asserted = expect(p).rejects.toThrow(/\[cover\].*封面图转存失败/);
        await vi.runAllTimersAsync();
        await asserted;
    });

    it('本机封面路径：Node 侧读成 data: URI 注入，管道按 data: 走上传', async () => {
        // 真实 fs I/O 与假计时器互相错位（setTimeout 在 runAllTimersAsync 之后才调度），
        // 这条用真实计时器（throttleMs=0，本来就不等）。
        vi.useRealTimers();
        const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const dir = await mkdtemp(join(tmpdir(), 'pubtest-'));
        const coverPath = join(dir, 'cover.png');
        await writeFile(coverPath, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
        try {
            const seen = [];
            const fetchImpl = vi.fn(async (url, opts) => {
                seen.push(String((opts && opts.body && opts.body.get && opts.body.get('url')) || url));
                return { ok: true, status: 200, text: async () => JSON.stringify({ src: 'https://cdn.example.com/local-new.png' }) };
            });
            await publishArticle(evalPage(fetchImpl), {
                title: 't', body: '<p>正文</p>', format: 'html', draftOnly: true,
                profile: makeProfile(),
                publishParams: { cover: coverPath },
            });
            // 上传请求里的 src 是 data: URI（本机文件已内联），publish 收到转存后的图床地址
            expect(seen.some((s) => s.indexOf('data:image/png;base64,') === 0)).toBe(true);
            expect(globalThis.__published.params.cover).toBe('https://cdn.example.com/local-new.png');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('本机封面路径读不到 → 硬报错', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
        await expect(publishArticle(evalPage(fetchImpl), {
            title: 't', body: '<p>正文</p>', format: 'html', draftOnly: true,
            profile: makeProfile(),
            publishParams: { cover: '/no/such/cover-file.png' },
        })).rejects.toThrow(/封面图读取失败/);
    });

    it('封面含非法字符（引号/空白）→ 拒绝', async () => {
        await expect(publishArticle(evalPage(vi.fn()), {
            title: 't', body: '<p>正文</p>', format: 'html', draftOnly: true,
            profile: makeProfile(),
            publishParams: { cover: 'https://a.com/x".png' },
        })).rejects.toThrow(/非法字符/);
    });
});
