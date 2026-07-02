// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { evalPageRuntime } from './page-runtime.js';

const PP = evalPageRuntime();

describe('PP.md5（字节级，供平台图片上传凭证用）', () => {
    const ref = (input) => createHash('md5').update(input).digest('hex');

    it('RFC 1321 标准向量', () => {
        expect(PP.md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
        expect(PP.md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
        expect(PP.md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    });

    it('padding 边界（55/56/63/64/65 字节）与长输入', () => {
        for (const n of [55, 56, 63, 64, 65, 200]) {
            const s = 'a'.repeat(n);
            expect(PP.md5(s)).toBe(ref(s));
        }
    });

    it('二进制输入：Uint8Array 与 ArrayBuffer 等价，含 >127 字节', () => {
        const bin = new Uint8Array(10000);
        for (let i = 0; i < bin.length; i++) bin[i] = (i * 37 + i * i) & 0xFF;
        expect(PP.md5(bin)).toBe(ref(bin));
        expect(PP.md5(bin.buffer)).toBe(ref(bin));
    });

    it('多字节 UTF-8 字符串按 UTF-8 编码取字节', () => {
        const s = '中文测试🀄';
        expect(PP.md5(s)).toBe(ref(Buffer.from(s, 'utf-8')));
    });
});

describe('PP.dataUriToBlob（CSP 拦 fetch(data:) 的绕行）', () => {
    it('base64 data URI → Blob，mime 与字节都正确', async () => {
        const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 255]);
        const blob = PP.dataUriToBlob('data:image/png;base64,' + bytes.toString('base64'));
        expect(blob.type).toBe('image/png');
        expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
    });

    it('非 base64（URL 编码文本）也能解', async () => {
        const blob = PP.dataUriToBlob('data:text/plain,hello%20world');
        expect(blob.type).toBe('text/plain');
        expect(Buffer.from(await blob.arrayBuffer()).toString()).toBe('hello world');
    });

    it('非 data: 输入抛错', () => {
        expect(() => PP.dataUriToBlob('https://a.com/x.png')).toThrow(/not a data/);
    });
});

describe('PP.preprocess（预处理器移植自 Wechatsync content-processor）', () => {
    it('convertSectionToDiv：section → div，保留内容', () => {
        const out = PP.preprocess('<section><p>hi</p></section>', { convertSectionToDiv: true });
        expect(out).toContain('<div>');
        expect(out).toContain('<p>hi</p>');
        expect(out).not.toContain('<section>');
    });

    it('removeEmptyLines：只含 br/空白的段落被删', () => {
        const out = PP.preprocess('<p>正文</p><p><br></p><p>   </p>', { removeEmptyLines: true });
        expect(out).toContain('正文');
        expect((out.match(/<p>/g) || []).length).toBe(1);
    });

    it('processCodeBlocks：探测语言并落到 data-lang/class', () => {
        const out = PP.preprocess('<pre><code class="language-js">const x = 1</code></pre>', { processCodeBlocks: true });
        expect(out).toMatch(/data-lang="js"|language-js/);
        expect(out).toContain('const x = 1');
    });

    it('convertTablesToText：表格转「列名: 值 | …」文本段落', () => {
        const html = '<table><thead><tr><th>名</th><th>值</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>';
        const out = PP.preprocess(html, { convertTablesToText: true });
        expect(out).not.toContain('<table');
        expect(out).toContain('名: a');
        expect(out).toContain('值: 1');
    });

    it('unwrapNestedFigures：figure 套 figure 解包成一层', () => {
        const out = PP.preprocess('<figure><figure><img src="x.png"></figure></figure>', { unwrapNestedFigures: true });
        expect(out).not.toMatch(/<figure>\s*<figure>/);
        expect(out).toContain('<img');
    });

    it('removeDataAttributes：去掉 data-*（保留 data-src）', () => {
        const out = PP.preprocess('<p data-foo="1" data-src="keep">x</p>', { removeDataAttributes: true });
        expect(out).not.toContain('data-foo');
        expect(out).toContain('data-src="keep"');
    });

    it('removeLinks + keepLinkDomains：站外链转 span，保留白名单域', () => {
        const html = '<a href="https://other.com/a">外</a><a href="https://mp.weixin.qq.com/s/x">内</a>';
        const out = PP.preprocess(html, { removeLinks: true, keepLinkDomains: ['mp.weixin.qq.com'] });
        expect(out).toContain('<span>外</span>');
        expect(out).toContain('href="https://mp.weixin.qq.com/s/x"');
    });

    it('removeSrcset/removeSizes：清掉响应式属性', () => {
        const out = PP.preprocess('<img src="a.png" srcset="a@2x 2x" sizes="100vw" loading="lazy">', { removeSrcset: true, removeSizes: true });
        expect(out).not.toContain('srcset');
        expect(out).not.toContain('sizes');
        expect(out).not.toContain('loading');
    });

    it('空 config：原样返回（无破坏）', () => {
        const out = PP.preprocess('<p>hi</p>', {});
        expect(out).toContain('<p>hi</p>');
    });
});

describe('PP.transferImages（统一图片转存）', () => {
    let calls;
    beforeEach(() => {
        calls = [];
        // jsdom 默认无 fetch：注入一个把「传 URL」式接口模拟成功的 fetch。
        global.fetch = vi.fn(async (url, opts) => {
            calls.push({ url, opts });
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ src: 'https://cdn.platform.com/rehosted.png' }),
            };
        });
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        delete global.fetch;
    });

    it('HTML <img> 外链图转存并改写 src', async () => {
        const spec = { url: 'https://api.platform.com/upload', bodyType: 'form', body: { url: '{src}' }, responsePath: 'src', throttleMs: 0 };
        const p = PP.transferImages('<p><img src="https://wai.lian/a.png"></p>', spec, []);
        await vi.runAllTimersAsync();
        const r = await p;
        expect(r.content).toContain('https://cdn.platform.com/rehosted.png');
        expect(r.content).not.toContain('wai.lian');
        expect(r.uploaded.length).toBe(1);
    });

    it('Markdown ![]() 同样被转存', async () => {
        const spec = { url: 'https://api.platform.com/upload', bodyType: 'form', body: { url: '{src}' }, responsePath: 'src', throttleMs: 0 };
        const p = PP.transferImages('![alt](https://wai.lian/b.png)', spec, []);
        await vi.runAllTimersAsync();
        const r = await p;
        expect(r.content).toContain('https://cdn.platform.com/rehosted.png');
        expect(r.uploaded.length).toBe(1);
    });

    it('skip 域名：已在本平台的图不重传', async () => {
        const spec = { url: 'https://api.platform.com/upload', bodyType: 'form', body: { url: '{src}' }, responsePath: 'src', throttleMs: 0 };
        const p = PP.transferImages('<img src="https://cdn.platform.com/old.png">', spec, ['cdn.platform.com']);
        await vi.runAllTimersAsync();
        const r = await p;
        expect(r.uploaded.length).toBe(0);
        expect(calls.length).toBe(0);
    });

    it('重复图片只上传一次（去重）', async () => {
        const spec = { url: 'https://api.platform.com/upload', bodyType: 'form', body: { url: '{src}' }, responsePath: 'src', throttleMs: 0 };
        const p = PP.transferImages('<img src="https://wai.lian/c.png"><img src="https://wai.lian/c.png">', spec, []);
        await vi.runAllTimersAsync();
        const r = await p;
        expect(calls.length).toBe(1);
        expect(r.uploaded.length).toBe(1);
    });

    it('无 spec：原样返回', async () => {
        const r = await PP.transferImages('<img src="https://wai.lian/d.png">', null, []);
        expect(r.content).toContain('wai.lian');
        expect(r.uploaded.length).toBe(0);
    });
});

describe('PP.processImagesWith（自定义上传函数路径）', () => {
    it('用平台自定义 uploadFn 转存并改写 src', async () => {
        vi.useFakeTimers();
        const seen = [];
        const uploadFn = async (src) => { seen.push(src); return { url: 'https://img.platform.com/x.png' }; };
        const p = PP.processImagesWith('<img src="https://wai.lian/e.png">![a](https://wai.lian/f.png)', uploadFn, { skip: [], throttleMs: 0 });
        await vi.runAllTimersAsync();
        const r = await p;
        vi.useRealTimers();
        expect(seen.length).toBe(2);
        expect(r.content.match(/img\.platform\.com/g).length).toBe(2);
        expect(r.uploaded.length).toBe(2);
    });

    it('uploadFn 抛错：记 failed，保留原图不炸', async () => {
        vi.useFakeTimers();
        const uploadFn = async () => { throw new Error('boom'); };
        const p = PP.processImagesWith('<img src="https://wai.lian/g.png">', uploadFn, { throttleMs: 0 });
        await vi.runAllTimersAsync();
        const r = await p;
        vi.useRealTimers();
        expect(r.failed.length).toBe(1);
        expect(r.content).toContain('wai.lian');
    });
});
