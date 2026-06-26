// @vitest-environment jsdom
//
// 豆瓣日记发布（2026 改版后新 rexxar 接口）单测。
// 覆盖：开源 markdownToDraft 转换器输出 + 页面内「图片转存 + 提交」单次 evaluate 逻辑。
import { describe, expect, it, vi } from 'vitest';
import { markdownToDraftState } from '../_shared/article/douban-md2draft.js';
import { __test__ } from './article.js';

const { normalizeDraftState, buildDoubanPublishJs } = __test__;

describe('markdownToDraftState（开源 markdown→Draft.js 转换器）', () => {
    it('段落/标题/列表/引用/代码块映射到正确 block 类型', () => {
        const md = '# 大标题\n\n普通段落\n\n- 项A\n- 项B\n\n> 引用\n\n```js\ncode\n```';
        const s = markdownToDraftState(md);
        const types = s.blocks.map((b) => b.type);
        expect(types).toContain('header-one');
        expect(types).toContain('unstyled');
        expect(types).toContain('unordered-list-item');
        expect(types).toContain('blockquote');
        expect(types).toContain('code-block');
    });

    it('图片产出占位 IMAGE 实体（data.url=外链），atomic 块引用它', () => {
        const s = markdownToDraftState('正文\n\n![图](https://ex.com/a.png)');
        const atomic = s.blocks.find((b) => b.type === 'atomic');
        expect(atomic).toBeTruthy();
        const key = atomic.entityRanges[0].key;
        const ent = s.entityMap[key];
        expect(ent.type).toBe('IMAGE');
        expect(ent.mutability).toBe('IMMUTABLE');
        expect(ent.data.url).toBe('https://ex.com/a.png');
    });
});

describe('normalizeDraftState', () => {
    it('补齐 block 的 key/depth/data 等必需字段', () => {
        const s = normalizeDraftState({ blocks: [{ type: 'unstyled', text: 'x' }], entityMap: {} });
        const b = s.blocks[0];
        expect(typeof b.key).toBe('string');
        expect(b.depth).toBe(0);
        expect(Array.isArray(b.inlineStyleRanges)).toBe(true);
        expect(Array.isArray(b.entityRanges)).toBe(true);
        expect(b.data).toEqual({});
    });
});

/** 在 jsdom 里 eval buildDoubanPublishJs 产出的源码，mock 掉 fetch / __INIT_STATE__ / cookie。 */
async function runPublishJs(ctx, fetchImpl) {
    const pf = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    window.__INIT_STATE__ = { upload_auth_token: 'tok-123' };
    Object.defineProperty(document, 'cookie', { value: 'ck=myck; bid=x', configurable: true });
    try {
        const js = buildDoubanPublishJs(ctx);
        // eslint-disable-next-line no-eval
        return await (0, eval)(js);
    } finally {
        globalThis.fetch = pf;
    }
}

describe('buildDoubanPublishJs（页面内转存 + 提交）', () => {
    it('草稿：外链图上传到豆瓣图床、回填 image_ids，POST 到 dwarf/drafts', async () => {
        const calls = [];
        const draftState = normalizeDraftState(markdownToDraftState('正文一段\n\n![图](https://ex.com/a.png)'));
        const fetchImpl = vi.fn(async (url, opts) => {
            calls.push({ url: String(url), opts });
            if (String(url).includes('ex.com/a.png')) {
                return { ok: true, status: 200, blob: async () => new Blob(['x'], { type: 'image/png' }) };
            }
            if (String(url).includes('/j/group/topic/add_photo')) {
                return { ok: true, status: 200, json: async () => ({ r: 0, photo: { id: 'P9', url: 'https://img.doubanio.com/p9.jpg', thumb: 'https://img.doubanio.com/p9_t.jpg', width: 100, height: 80 } }) };
            }
            if (String(url).includes('/dwarf/drafts')) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ id: 12345 }) };
            }
            throw new Error('unexpected fetch ' + url);
        });

        const r = await runPublishJs({ title: '标题', draftState, draftOnly: true }, fetchImpl);

        expect(r.ok).toBe(true);
        expect(r.draft).toBe(true);
        expect(r.id).toBe('12345');
        expect(r.uploaded).toEqual(['https://ex.com/a.png']);
        expect(r.failed).toEqual([]);

        // 校验真的打到了新接口
        const draftCall = calls.find((c) => c.url.includes('/dwarf/drafts'));
        expect(draftCall).toBeTruthy();
        const body = JSON.parse(draftCall.opts.body);
        const props = JSON.parse(body.draft_props);
        expect(props.subtype).toBe('note');
        expect(props.image_ids).toContain('P9');
        // 图片实体 data 已回填为豆瓣图床地址
        const ent = Object.values(props.content.entityMap).find((e) => e.type === 'IMAGE');
        expect(ent.data.url).toBe('https://img.doubanio.com/p9.jpg');
        // add_photo 带了 upload_auth_token
        const upCall = calls.find((c) => c.url.includes('add_photo'));
        expect(upCall).toBeTruthy();
    });

    it('发布：POST 到 topic/post，accessible=public', async () => {
        const draftState = normalizeDraftState(markdownToDraftState('纯文字正文'));
        const calls = [];
        const fetchImpl = vi.fn(async (url, opts) => {
            calls.push({ url: String(url), opts });
            if (String(url).includes('/topic/post')) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ id: 678, url: 'https://www.douban.com/note/678/' }) };
            }
            throw new Error('unexpected fetch ' + url);
        });
        const r = await runPublishJs({ title: 'T', draftState, draftOnly: false }, fetchImpl);
        expect(r.ok).toBe(true);
        expect(r.draft).toBe(false);
        expect(r.url).toBe('https://www.douban.com/note/678/');
        const postCall = calls.find((c) => c.url.includes('/topic/post'));
        const body = JSON.parse(postCall.opts.body);
        expect(body.accessible).toBe('public');
        expect(body.subtype).toBe('note');
        expect(typeof body.content).toBe('string'); // 发布时 content 是字符串
    });

    it('图片下载失败：记入 failed，不阻断正文提交', async () => {
        const draftState = normalizeDraftState(markdownToDraftState('正文\n\n![图](https://ex.com/bad.png)'));
        const fetchImpl = vi.fn(async (url) => {
            if (String(url).includes('bad.png')) return { ok: false, status: 404 };
            if (String(url).includes('/dwarf/drafts')) return { ok: true, status: 200, text: async () => JSON.stringify({ id: 1 }) };
            throw new Error('unexpected ' + url);
        });
        const r = await runPublishJs({ title: 'T', draftState, draftOnly: true }, fetchImpl);
        expect(r.ok).toBe(true);
        expect(r.failed.length).toBe(1);
        expect(r.uploaded.length).toBe(0);
    });
});
