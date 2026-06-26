import { describe, expect, it, vi } from 'vitest';
import {
    extractImageRefs,
    pickPath,
    buildTransferImagesJs,
    transferImages,
} from './images.js';

/**
 * 一个把 page.evaluate 当作「在本进程里跑这段页面脚本」的假 page。
 * 临时把 globalThis.fetch / globalThis.document 换成测试桩，跑完还原，
 * 这样就能在 Node 里真正执行被注入页面的转存逻辑（间接 eval 在全局作用域执行）。
 */
function evalPage(fetchImpl, cookie = '_xsrf=tok123') {
    return {
        evaluate: async (js) => {
            const prevFetch = globalThis.fetch;
            const prevDoc = globalThis.document;
            globalThis.fetch = fetchImpl;
            globalThis.document = { cookie };
            try {
                // eslint-disable-next-line no-eval
                return await (0, eval)(js);
            } finally {
                globalThis.fetch = prevFetch;
                globalThis.document = prevDoc;
            }
        },
    };
}

function jsonResponse(obj, { ok = true, status = 200 } = {}) {
    return { ok, status, text: async () => JSON.stringify(obj) };
}

describe('extractImageRefs', () => {
    it('finds both HTML and Markdown images', () => {
        const content =
            '<p><img alt="a" src="https://orig.com/a.png" width="50"></p>\n' +
            '段落 ![图](https://orig.com/b.jpg "标题") 结束';
        const refs = extractImageRefs(content);
        expect(refs.map((r) => r.src)).toEqual([
            'https://orig.com/a.png',
            'https://orig.com/b.jpg',
        ]);
    });

    it('returns empty for content without images', () => {
        expect(extractImageRefs('纯文本，无图')).toEqual([]);
        expect(extractImageRefs('')).toEqual([]);
    });
});

describe('pickPath', () => {
    it('reads nested paths', () => {
        expect(pickPath({ data: { url: 'x' } }, 'data.url')).toBe('x');
        expect(pickPath({ src: 'y' }, 'src')).toBe('y');
        expect(pickPath({}, 'a.b')).toBeUndefined();
    });
});

describe('transferImages (form / 传-URL 策略)', () => {
    const spec = {
        url: 'https://zhuanlan.zhihu.com/api/uploaded_images',
        bodyType: 'form',
        body: { url: '{src}', source: 'article' },
        headers: { 'x-requested-with': 'fetch' },
        xsrf: true,
        responsePath: 'src',
        throttleMs: 0,
    };

    it('re-uploads remote images and rewrites src in place', async () => {
        const seen = [];
        const fetchImpl = vi.fn(async (url, opts) => {
            seen.push({ url, body: opts.body });
            return jsonResponse({ src: 'https://pic.zhimg.com/new.png' });
        });
        const page = evalPage(fetchImpl);
        const content = '<p><img alt="封面" src="https://orig.com/a.png"></p>';

        const out = await transferImages(page, content, { spec, skip: ['zhimg.com'] });

        expect(out.failed).toEqual([]);
        expect(out.uploaded).toHaveLength(1);
        // 原 src 被换成平台返回的新地址，alt 等属性保留
        expect(out.content).toBe('<p><img alt="封面" src="https://pic.zhimg.com/new.png"></p>');
        // 上传请求带上了原图 URL 与 xsrf
        expect(seen[0].url).toBe('https://zhuanlan.zhihu.com/api/uploaded_images');
        expect(String(seen[0].body)).toContain('url=https%3A%2F%2Forig.com%2Fa.png');
    });

    it('skips images already hosted on the platform', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ src: 'should-not-be-used' }));
        const page = evalPage(fetchImpl);
        const content = '<img src="https://pic2.zhimg.com/already.png">';

        const out = await transferImages(page, content, { spec, skip: ['zhimg.com'] });

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(out.content).toBe(content);
        expect(out.uploaded).toEqual([]);
    });

    it('records a failure and leaves the original src untouched', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, { ok: false, status: 403 }));
        const page = evalPage(fetchImpl);
        const content = '<img src="https://orig.com/a.png">';

        const out = await transferImages(page, content, { spec, skip: [] });

        expect(out.uploaded).toEqual([]);
        expect(out.failed).toHaveLength(1);
        expect(out.failed[0].error).toContain('403');
        expect(out.content).toBe(content);
    });

    it('uploads each unique src only once (dedup)', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ src: 'https://pic.zhimg.com/x.png' }));
        const page = evalPage(fetchImpl);
        const content =
            '<img src="https://orig.com/dup.png"> 和 <img src="https://orig.com/dup.png">';

        const out = await transferImages(page, content, { spec, skip: [] });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(out.uploaded).toHaveLength(1);
        expect(out.content).not.toContain('orig.com');
    });
});

describe('transferImages (binary-multipart 策略)', () => {
    const spec = {
        url: 'https://upload.example.com/img',
        bodyType: 'binary-multipart',
        fileField: 'image',
        body: { biz: 'article' },
        responsePath: 'data.url',
        throttleMs: 0,
    };

    it('fetches bytes then uploads as multipart', async () => {
        const fetchImpl = vi.fn(async (url) => {
            if (url === 'https://orig.com/a.png') {
                return { ok: true, status: 200, blob: async () => new Blob(['bytes'], { type: 'image/png' }) };
            }
            return jsonResponse({ data: { url: 'https://cdn.example.com/uploaded.png' } });
        });
        const page = evalPage(fetchImpl);
        const content = '<img src="https://orig.com/a.png">';

        const out = await transferImages(page, content, { spec, skip: [] });

        expect(out.failed).toEqual([]);
        expect(out.content).toBe('<img src="https://cdn.example.com/uploaded.png">');
        // 第一次 fetch 取字节，第二次 fetch 上传
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe('buildTransferImagesJs', () => {
    it('injects content/spec/skip as JSON and returns an async IIFE', () => {
        const js = buildTransferImagesJs('<img src="a">', { url: 'u' }, ['x']);
        expect(js.startsWith('(async () => {')).toBe(true);
        expect(js).toContain(JSON.stringify('<img src="a">'));
        expect(js).toContain(JSON.stringify({ url: 'u' }));
        expect(js).toContain(JSON.stringify(['x']));
    });
});

describe('transferImages (无 spec / 无图 短路)', () => {
    it('returns content unchanged when no spec', async () => {
        const out = await transferImages(null, '<img src="a">', {});
        expect(out.content).toBe('<img src="a">');
    });
    it('does not call evaluate when content has no images', async () => {
        const page = { evaluate: vi.fn() };
        const out = await transferImages(page, '纯文本', { spec: { url: 'u' } });
        expect(page.evaluate).not.toHaveBeenCalled();
        expect(out.content).toBe('纯文本');
    });
});
