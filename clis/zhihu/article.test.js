// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { evalPageRuntime } from '../_shared/article/page-runtime.js';
import { zhihuProfile } from './article.js';

const PP = evalPageRuntime();

// ── profile 声明结构 ────────────────────────────────────────────────────────
describe('zhihu article profile 声明', () => {
    it('outputFormat 为 html（知乎只吃 HTML）', () => {
        expect(zhihuProfile.outputFormat).toBe('html');
    });

    it('image.skip 包含知乎图床域名', () => {
        expect(zhihuProfile.image.skip).toContain('zhimg.com');
    });

    it('image.uploadFn 是函数（远程 URL / data: 双路径）', () => {
        expect(typeof zhihuProfile.image.uploadFn).toBe('function');
        const src = zhihuProfile.image.uploadFn.toString();
        expect(src).toContain('api/uploaded_images');      // 传 URL 式
        expect(src).toContain('api.zhihu.com/images');     // 二进制凭证
        expect(src).toContain('zhihu-pics-upload.zhimg.com'); // OSS 直传
        expect(src).toContain('PP.md5');                   // 图片字节 hash
    });

    it('publish 函数体含题图字段（titleImage）', () => {
        const src = zhihuProfile.publish.toString();
        expect(src).toContain('titleImage');
        expect(src).toContain('isTitleImageFullScreen');
    });
});

// ── uploadFn：双路径上传 ────────────────────────────────────────────────────
describe('zhihu uploadFn（页面内图片上传）', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    async function run(src, fetchImpl) {
        vi.stubGlobal('fetch', fetchImpl);
        return zhihuProfile.image.uploadFn(src, PP);
    }

    it('远程 URL：POST uploaded_images 表单，返回服务端转存地址', async () => {
        let captured = null;
        const fetchImpl = vi.fn(async (url, opts) => {
            captured = { url, opts };
            return { ok: true, status: 200, text: async () => JSON.stringify({ src: 'https://pic4.zhimg.com/rehosted.png' }) };
        });
        const out = await run('https://other.com/a.png', fetchImpl);
        expect(out.url).toBe('https://pic4.zhimg.com/rehosted.png');
        expect(captured.url).toBe('https://zhuanlan.zhihu.com/api/uploaded_images');
        expect(captured.opts.body.get('url')).toBe('https://other.com/a.png');
        expect(captured.opts.body.get('source')).toBe('article');
    });

    it('远程 URL 转存失败 → 抛错（不静默）', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad' }));
        await expect(run('https://other.com/a.png', fetchImpl)).rejects.toThrow(/URL 转存失败/);
    });

    it('data: URI + 服务端已有该图（state=1）：轮询详情取 original_hash', async () => {
        const dataUri = 'data:image/png;base64,' + Buffer.from([1, 2, 3, 4]).toString('base64');
        const fetchImpl = vi.fn(async (url, opts) => {
            if (String(url).startsWith('data:')) {
                return { blob: async () => new Blob([Buffer.from([1, 2, 3, 4])], { type: 'image/png' }) };
            }
            if (url === 'https://api.zhihu.com/images') {
                const body = JSON.parse(opts.body);
                expect(body.source).toBe('article');
                expect(body.image_hash).toMatch(/^[0-9a-f]{32}$/);
                return {
                    ok: true, status: 200,
                    text: async () => JSON.stringify({ upload_file: { state: 1, image_id: 'img1', object_key: 'k1' } }),
                };
            }
            if (url === 'https://api.zhihu.com/images/img1') {
                return { json: async () => ({ status: 'completed', original_hash: 'abc123' }) };
            }
            throw new Error('意外请求: ' + url);
        });
        const out = await run(dataUri, fetchImpl);
        expect(out.url).toBe('https://pic4.zhimg.com/abc123');
    });

    it('data: URI + 新图：OSS PUT（V1 签名头齐全），返回 object_key 地址', async () => {
        const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 9, 9]);
        const dataUri = 'data:image/png;base64,' + bytes.toString('base64');
        let putReq = null;
        const fetchImpl = vi.fn(async (url, opts) => {
            if (String(url).startsWith('data:')) {
                return { blob: async () => new Blob([bytes], { type: 'image/png' }) };
            }
            if (url === 'https://api.zhihu.com/images') {
                return {
                    ok: true, status: 200,
                    text: async () => JSON.stringify({
                        upload_file: { state: 0, image_id: 'img2', object_key: 'v2-objkey' },
                        upload_token: { access_id: 'AID', access_key: 'AKEY', access_token: 'ATOKEN' },
                    }),
                };
            }
            if (url === 'https://zhihu-pics-upload.zhimg.com/v2-objkey') {
                putReq = opts;
                return { ok: true, status: 200, text: async () => '' };
            }
            throw new Error('意外请求: ' + url);
        });
        const out = await run(dataUri, fetchImpl);
        expect(out.url).toBe('https://pic4.zhimg.com/v2-objkey');
        expect(putReq.method).toBe('PUT');
        expect(putReq.headers['Authorization']).toMatch(/^OSS AID:[A-Za-z0-9+/=]+$/);
        expect(putReq.headers['x-oss-security-token']).toBe('ATOKEN');
        expect(putReq.headers['x-oss-user-agent']).toBe('aliyun-sdk-js/6.8.0');
        expect(putReq.headers['Content-Type']).toBe('image/png');
    });

    it('data: URI + GIF：object_key 追加 .gif 后缀', async () => {
        const bytes = Buffer.from('GIF89a');
        const dataUri = 'data:image/gif;base64,' + bytes.toString('base64');
        const fetchImpl = vi.fn(async (url) => {
            if (String(url).startsWith('data:')) {
                return { blob: async () => new Blob([bytes], { type: 'image/gif' }) };
            }
            if (url === 'https://api.zhihu.com/images') {
                return {
                    ok: true, status: 200,
                    text: async () => JSON.stringify({
                        upload_file: { state: 0, image_id: 'g', object_key: 'gifkey' },
                        upload_token: { access_id: 'a', access_key: 'k', access_token: 't' },
                    }),
                };
            }
            return { ok: true, status: 200, text: async () => '' };
        });
        const out = await run(dataUri, fetchImpl);
        expect(out.url).toBe('https://pic4.zhimg.com/gifkey.gif');
    });
});

// ── publish：题图（titleImage）写入草稿 PATCH ───────────────────────────────
describe('zhihu publish（页面内发布，题图）', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    function fetchRecorder(patched) {
        return vi.fn(async (url, opts) => {
            if (String(url).endsWith('/api/articles/drafts')) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ id: 777 }) };
            }
            if (String(url).endsWith('/777/draft')) {
                patched.body = JSON.parse(opts.body);
                return { ok: true, status: 200, text: async () => '' };
            }
            if (String(url).endsWith('/777/publish')) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'https://zhuanlan.zhihu.com/p/777' }) };
            }
            throw new Error('意外请求: ' + url);
        });
    }

    it('有封面：PATCH 带 titleImage + isTitleImageFullScreen=false', async () => {
        const patched = {};
        vi.stubGlobal('fetch', fetchRecorder(patched));
        const out = await zhihuProfile.publish(
            { title: 'T', content: '<p>x</p>', draftOnly: true, params: { cover: 'https://pic4.zhimg.com/cov.png' } },
            PP,
        );
        expect(out.ok).toBe(true);
        expect(patched.body.titleImage).toBe('https://pic4.zhimg.com/cov.png');
        expect(patched.body.isTitleImageFullScreen).toBe(false);
    });

    it('无封面：PATCH 不带 titleImage 字段', async () => {
        const patched = {};
        vi.stubGlobal('fetch', fetchRecorder(patched));
        const out = await zhihuProfile.publish({ title: 'T', content: '<p>x</p>', draftOnly: true, params: null }, PP);
        expect(out.ok).toBe(true);
        expect('titleImage' in patched.body).toBe(false);
    });

    it('封面不是 zhimg 地址（转存未生效）→ stage=cover 失败', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('不应发请求'); }));
        const out = await zhihuProfile.publish(
            { title: 'T', content: '<p>x</p>', draftOnly: true, params: { cover: 'https://other.com/c.png' } },
            PP,
        );
        expect(out.ok).toBe(false);
        expect(out.stage).toBe('cover');
    });
});
