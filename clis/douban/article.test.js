// @vitest-environment jsdom
/**
 * 豆瓣日记发布适配器单测
 *
 * 手法：evalPage 构造一个假 page 对象，把 page.evaluate 改成在 jsdom 里直接 eval。
 * stub fetch，断言发出的请求结构与豆瓣 API 约定一致。
 * 不做真实浏览器调试（无登录态）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPublishJs } from '../_shared/article/publish.js';

// ── 辅助 ───────────────────────────────────────────────────────────────────────

/**
 * 构造假 page（evalPage），把 evaluate 改成在当前 jsdom 里执行 JS。
 * fetchImpl 会在 evaluate 期间临时替换 globalThis.fetch。
 */
function evalPage(fetchImpl) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: async (js) => {
            const prev = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            try {
                // eslint-disable-next-line no-eval
                return await (0, eval)(js);
            } finally {
                globalThis.fetch = prev;
            }
        },
    };
}

/** 构造页面 HTML 模拟已登录的豆瓣 /note/create 页面 */
function makeDoubanPageHtml(noteId = '123456', ck = 'abc123', uploadToken = 'tok999') {
    return `<html><body>
    <script>
      var _USER_NAME = 'testuser';
      var _USER_AVATAR = 'https://img.douban.com/avatar.jpg';
      var _POST_PARAMS = { siteCookie: { value: '${uploadToken}' } };
    </script>
    <input name="note_id" value="${noteId}">
    <input name="ck" value="${ck}">
    </body></html>`;
}

/** 豆瓣 profile（从 article.js 中复制等价版本，避免引入时触发 cli() 副作用） */
async function loadDoubanProfile() {
    // 直接内联 profile 供测试，与 article.js 的 doubanProfile 等价
    const profile = {
        home: 'https://www.douban.com/note/create',
        originRe: '^https?://([^/]*\\.)?douban\\.com(/|$)',
        outputFormat: 'markdown',
        image: {
            skip: ['doubanio.com', 'douban.com'],
            uploadFn: async (src, PP) => {
                if (!globalThis.__doubanPhotoMap) globalThis.__doubanPhotoMap = {};
                if (!globalThis.__doubanFormData) {
                    const html = document.documentElement.innerHTML;
                    const noteIdM = html.match(/name="note_id"\s+value="(\d+)"/);
                    const ckM = html.match(/name="ck"\s+value="([^"]+)"/);
                    const postParamsM = html.match(/_POST_PARAMS\s*=\s*(\{[\s\S]*?\});/);
                    if (!noteIdM || !ckM) throw new Error('豆瓣：无法从页面解析 note_id / ck，请确认已登录');
                    let uploadAuthToken = '';
                    if (postParamsM) {
                        const scM = postParamsM[1].match(/siteCookie[^}]*value\s*:\s*['"]([^'"]+)['"]/);
                        if (scM) uploadAuthToken = scM[1];
                    }
                    globalThis.__doubanFormData = { note_id: noteIdM[1], ck: ckM[1], uploadAuthToken };
                }
                const fd = globalThis.__doubanFormData;
                const imgResp = await fetch(src, { credentials: 'omit' });
                if (!imgResp.ok) throw new Error('图片下载失败：' + src);
                const blob = await imgResp.blob();
                const form = new FormData();
                // 与真适配器一致：upload_auth_token 必需，缺则抛错（不静默跳过）。
                if (!fd.uploadAuthToken) throw new Error('豆瓣：未获取上传凭证 upload_auth_token');
                form.append('note_id', fd.note_id);
                form.append('image_file', blob, 'image.jpg');
                form.append('ck', fd.ck);
                form.append('upload_auth_token', fd.uploadAuthToken);
                const upResp = await fetch('https://www.douban.com/j/note/add_photo', {
                    method: 'POST', credentials: 'include', body: form,
                });
                if (!upResp.ok) throw new Error('豆瓣图片上传 HTTP ' + upResp.status);
                const res = await upResp.json();
                if (!res.photo || !res.photo.url) throw new Error('豆瓣图片上传：无 photo.url');
                const photo = res.photo;
                globalThis.__doubanPhotoMap[photo.url] = photo;
                return { url: photo.url };
            },
        },
        publish: async (I, PP) => {
            const fd = globalThis.__doubanFormData;
            if (!fd) {
                const html = document.documentElement.innerHTML;
                const noteIdM = html.match(/name="note_id"\s+value="(\d+)"/);
                const ckM = html.match(/name="ck"\s+value="([^"]+)"/);
                if (!noteIdM || !ckM) {
                    return { ok: false, stage: 'parse', message: '豆瓣：无法从页面解析 note_id / ck' };
                }
                globalThis.__doubanFormData = { note_id: noteIdM[1], ck: ckM[1], uploadAuthToken: '' };
            }
            const formData = globalThis.__doubanFormData;
            const photoMap = globalThis.__doubanPhotoMap || {};
            var entityMap = {};
            var entityKey = 0;
            function makeBlock(type, text, inlineStyleRanges, entityRanges) {
                return { key: String(entityKey++), type, text, depth: 0, inlineStyleRanges: inlineStyleRanges || [], entityRanges: entityRanges || [], data: {} };
            }
            function parseInline(raw) {
                var text = ''; var styles = []; var i = 0; var src = raw;
                while (i < src.length) {
                    if ((src[i] === '*' && src[i + 1] === '*') || (src[i] === '_' && src[i + 1] === '_')) {
                        var delim = src.slice(i, i + 2); var end = src.indexOf(delim, i + 2);
                        if (end !== -1) { var inner = src.slice(i + 2, end); var start = text.length; text += inner; styles.push({ offset: start, length: inner.length, style: 'BOLD' }); i = end + 2; continue; }
                    }
                    if ((src[i] === '*' || src[i] === '_') && src[i + 1] !== src[i]) {
                        var ch = src[i]; var end2 = src.indexOf(ch, i + 1);
                        if (end2 !== -1 && end2 > i + 1) { var inner2 = src.slice(i + 1, end2); var start2 = text.length; text += inner2; styles.push({ offset: start2, length: inner2.length, style: 'ITALIC' }); i = end2 + 1; continue; }
                    }
                    if (src[i] === '`') { var end3 = src.indexOf('`', i + 1); if (end3 !== -1) { var inner3 = src.slice(i + 1, end3); var start3 = text.length; text += inner3; styles.push({ offset: start3, length: inner3.length, style: 'CODE' }); i = end3 + 1; continue; } }
                    if (src[i] === '[') { var closeBracket = src.indexOf('](', i + 1); if (closeBracket !== -1) { var closeParen = src.indexOf(')', closeBracket + 2); if (closeParen !== -1) { var linkText = src.slice(i + 1, closeBracket); text += linkText; i = closeParen + 1; continue; } } }
                    text += src[i]; i++;
                }
                return { text, inlineStyleRanges: styles };
            }
            var blocks = []; var lines = I.content.split('\n'); var li = 0;
            while (li < lines.length) {
                var line = lines[li];
                var imgM = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
                if (imgM) {
                    var imgUrl = imgM[2].trim(); var photo = photoMap[imgUrl]; var k = entityKey++;
                    if (photo) { entityMap[k] = { type: 'IMAGE', mutability: 'IMMUTABLE', data: { id: photo.id, src: photo.url, thumb: photo.thumb, url: photo.url, width: photo.width || 0, height: photo.height || 0, file_name: photo.file_name || '', file_size: photo.file_size || 0 } }; }
                    else { entityMap[k] = { type: 'IMAGE', mutability: 'IMMUTABLE', data: { id: '', src: imgUrl, thumb: imgUrl, url: imgUrl } }; }
                    blocks.push({ key: String(entityKey++), type: 'atomic', text: ' ', depth: 0, inlineStyleRanges: [], entityRanges: [{ offset: 0, length: 1, key: k }], data: {} });
                    li++; continue;
                }
                if (line.match(/^```/)) {
                    var codeLines = []; li++;
                    while (li < lines.length && !lines[li].match(/^```/)) { codeLines.push(lines[li]); li++; }
                    li++; blocks.push(makeBlock('code-block', codeLines.join('\n'), [], [])); continue;
                }
                var hM = line.match(/^(#{1,6})\s+(.+)/);
                if (hM) { var level = hM[1].length; var hType = level <= 2 ? 'header-two' : 'header-three'; var p0 = parseInline(hM[2]); blocks.push(makeBlock(hType, p0.text, p0.inlineStyleRanges, [])); li++; continue; }
                var ulM = line.match(/^[\*\-\+]\s+(.+)/);
                if (ulM) { var p1 = parseInline(ulM[1]); blocks.push(makeBlock('unordered-list-item', p1.text, p1.inlineStyleRanges, [])); li++; continue; }
                var olM = line.match(/^\d+\.\s+(.+)/);
                if (olM) { var p2 = parseInline(olM[1]); blocks.push(makeBlock('ordered-list-item', p2.text, p2.inlineStyleRanges, [])); li++; continue; }
                if (line.match(/^---+$/) || line.match(/^\*\*\*+$/)) { blocks.push(makeBlock('unstyled', '', [], [])); li++; continue; }
                var bqM = line.match(/^>\s*(.*)/);
                if (bqM) { var p3 = parseInline(bqM[1]); blocks.push(makeBlock('blockquote', p3.text, p3.inlineStyleRanges, [])); li++; continue; }
                if (!line.trim()) { blocks.push(makeBlock('unstyled', '', [], [])); li++; continue; }
                var p4 = parseInline(line); blocks.push(makeBlock('unstyled', p4.text, p4.inlineStyleRanges, [])); li++;
            }
            if (blocks.length === 0) blocks.push(makeBlock('unstyled', '', [], []));
            var draftContent = JSON.stringify({ blocks, entityMap });
            const saveResp = await fetch('https://www.douban.com/j/note/autosave', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://www.douban.com', 'Referer': 'https://www.douban.com/note/create' },
                body: new URLSearchParams({ is_rich: '1', note_id: formData.note_id, note_title: I.title, note_text: draftContent, introduction: '', note_privacy: 'P', cannot_reply: '', author_tags: '', accept_donation: '', donation_notice: '', is_original: '', ck: formData.ck }),
            });
            const saveText = await saveResp.text();
            var saveData = null; try { saveData = JSON.parse(saveText); } catch (e) {}
            if (!saveResp.ok) return { ok: false, stage: 'save', status: saveResp.status, message: saveText.slice(0, 300) };
            var noteId = formData.note_id;
            var noteUrl = (saveData && saveData.url) || ('https://www.douban.com/note/' + noteId + '/');
            globalThis.__doubanFormData = null;
            globalThis.__doubanPhotoMap = null;
            return { ok: true, id: noteId, url: noteUrl, draft: !!I.draftOnly };
        },
    };
    return profile;
}

// ── 测试 ───────────────────────────────────────────────────────────────────────

describe('豆瓣 profile.preprocessConfig', () => {
    it('markdown 平台：outputFormat 为 markdown，不声明 preprocessConfig', async () => {
        const profile = await loadDoubanProfile();
        expect(profile.outputFormat).toBe('markdown');
        expect(profile.preprocessConfig).toBeUndefined();
    });
});

describe('豆瓣 profile.publish — 纯文本成功路径（通过 buildPublishJs 在 jsdom 内执行）', () => {
    beforeEach(() => {
        delete globalThis.__doubanFormData;
        delete globalThis.__doubanPhotoMap;
    });
    afterEach(() => {
        delete globalThis.__doubanFormData;
        delete globalThis.__doubanPhotoMap;
    });

    it('向 /j/note/autosave 发 POST，note_title 与 note_text 正确，返回 ok:true', async () => {
        // 设置 jsdom 页面 HTML，模拟 /note/create 登录状态
        document.documentElement.innerHTML = makeDoubanPageHtml('654321', 'ck_test', 'tok_test');

        const fetchImpl = vi.fn(async (url, init) => {
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({ r: 0, url: 'https://www.douban.com/note/654321/' }),
                json: async () => ({ r: 0, url: 'https://www.douban.com/note/654321/' }),
            };
        });

        const profile = await loadDoubanProfile();
        const ctx = {
            title: '测试日记标题',
            content: '## 小标题\n\n正文内容',
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, profile.publish.toString(), profile.image.uploadFn.toString());
        const page = evalPage(fetchImpl);
        const result = await page.evaluate(js);

        expect(result.ok).toBe(true);
        expect(result.id).toBe('654321');
        expect(result.url).toContain('654321');
        expect(result.draft).toBe(false);

        // 验证 autosave 被调用
        const autosaveCall = fetchImpl.mock.calls.find(([url]) => url === 'https://www.douban.com/j/note/autosave');
        expect(autosaveCall).toBeDefined();
        const params = new URLSearchParams(autosaveCall[1].body);
        expect(params.get('note_title')).toBe('测试日记标题');
        expect(params.get('ck')).toBe('ck_test');
        expect(params.get('is_rich')).toBe('1');
    });
});

describe('豆瓣 Draft.js 生成 — 通过 buildPublishJs 端到端', () => {
    beforeEach(() => {
        // 注意：此组测试故意不用 vi.useFakeTimers()。
        // processImagesWith 内部有 setTimeout(r, 300) 节流，fakeTimers 下会卡死。
        delete globalThis.__doubanFormData;
        delete globalThis.__doubanPhotoMap;
    });
    afterEach(() => {
        delete globalThis.__doubanFormData;
        delete globalThis.__doubanPhotoMap;
    });

    it('纯文本 Markdown 正确转为 Draft.js 并发送 autosave', async () => {
        // 让 jsdom document 有正确的 HTML
        document.documentElement.innerHTML = makeDoubanPageHtml('111', 'ck1', 'tok1');

        const capturedRequests = [];
        const fetchImpl = vi.fn(async (url, init) => {
            capturedRequests.push({ url, init: init ? { ...init, body: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body } : undefined });
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({ r: 0, url: 'https://www.douban.com/note/111/' }),
                json: async () => ({ r: 0, url: 'https://www.douban.com/note/111/' }),
            };
        });

        const profile = await loadDoubanProfile();
        const ctx = {
            title: '豆瓣日记',
            content: '# 大标题\n\n段落正文\n\n- 列表项',
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, profile.publish.toString(), profile.image.uploadFn.toString());

        const page = evalPage(fetchImpl);
        const result = await page.evaluate(js);

        expect(result.ok).toBe(true);
        expect(result.id).toBe('111');

        // 验证 autosave 被调用
        const autosaveReq = capturedRequests.find(r => r.url === 'https://www.douban.com/j/note/autosave');
        expect(autosaveReq).toBeDefined();

        // 验证 note_text 是合法 Draft.js JSON
        const noteText = autosaveReq.init.body.note_text;
        const draft = JSON.parse(noteText);
        expect(draft).toHaveProperty('blocks');
        expect(draft).toHaveProperty('entityMap');
        expect(Array.isArray(draft.blocks)).toBe(true);

        // 标题块
        const headerBlock = draft.blocks.find(b => b.type === 'header-two');
        expect(headerBlock).toBeDefined();
        expect(headerBlock.text).toBe('大标题');

        // 列表块
        const listBlock = draft.blocks.find(b => b.type === 'unordered-list-item');
        expect(listBlock).toBeDefined();
        expect(listBlock.text).toBe('列表项');

        // note_title 正确
        expect(autosaveReq.init.body.note_title).toBe('豆瓣日记');
        // ck 正确
        expect(autosaveReq.init.body.ck).toBe('ck1');
        // is_rich=1
        expect(autosaveReq.init.body.is_rich).toBe('1');
    });

    it('图片转存：uploadFn 上传图片并将 photo 数据写入 Draft.js entityMap', async () => {
        document.documentElement.innerHTML = makeDoubanPageHtml('222', 'ck2', 'tok2');

        const photoDomain = 'https://img9.doubanio.com/view/note/l/public/p222.webp';
        const capturedUploadRequests = [];

        const fetchImpl = vi.fn(async (url, init) => {
            // 图片下载（外链）
            if (url === 'https://example.com/image.jpg') {
                return {
                    ok: true, status: 200,
                    blob: async () => new Blob(['fake-image'], { type: 'image/jpeg' }),
                };
            }
            // 图片上传
            if (url === 'https://www.douban.com/j/note/add_photo') {
                capturedUploadRequests.push({ url, init });
                return {
                    ok: true, status: 200,
                    json: async () => ({
                        photo: {
                            id: 'photo_id_001',
                            url: photoDomain,
                            thumb: photoDomain + '?thumb=1',
                            width: 800, height: 600,
                            file_name: 'image.jpg',
                            file_size: 12345,
                        },
                    }),
                };
            }
            // autosave
            if (url === 'https://www.douban.com/j/note/autosave') {
                return {
                    ok: true, status: 200,
                    text: async () => JSON.stringify({ r: 0, url: 'https://www.douban.com/note/222/' }),
                };
            }
            return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
        });

        const profile = await loadDoubanProfile();
        const ctx = {
            title: '带图日记',
            content: '开头段落\n\n![图片](https://example.com/image.jpg)\n\n结尾段落',
            draftOnly: false,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: ['doubanio.com', 'douban.com'],
        };
        const js = buildPublishJs(ctx, profile.publish.toString(), profile.image.uploadFn.toString());
        const page = evalPage(fetchImpl);
        const result = await page.evaluate(js);

        expect(result.ok).toBe(true);
        // 图片上传被调用
        expect(capturedUploadRequests.length).toBe(1);
        // 必需凭证 upload_auth_token 进了 FormData（缺它豆瓣会拒、图全裂）
        expect(capturedUploadRequests[0].init.body.get('upload_auth_token')).toBe('tok2');
        // 上传了 1 张图
        expect(result.uploaded).toHaveLength(1);
        expect(result.uploaded[0].url).toBe(photoDomain);
    });
});

describe('豆瓣 profile.publish — 未登录 / 页面无表单参数', () => {
    beforeEach(() => {
        delete globalThis.__doubanFormData;
        delete globalThis.__doubanPhotoMap;
    });
    afterEach(() => {
        delete globalThis.__doubanFormData;
        delete globalThis.__doubanPhotoMap;
    });

    it('页面缺少 note_id / ck 时返回 ok:false', async () => {
        // 空页面，无登录态
        document.documentElement.innerHTML = '<html><body><p>请登录</p></body></html>';

        const profile = await loadDoubanProfile();
        const I = { title: '测试', content: '内容', draftOnly: false };
        const result = await profile.publish(I, {});

        expect(result.ok).toBe(false);
        expect(result.stage).toBe('parse');
        expect(result.message).toContain('note_id');
    });
});

describe('豆瓣 Markdown → Draft.js 格式转换（通过 buildPublishJs）', () => {
    beforeEach(() => {
        // 不使用 fakeTimers，publishArticle 内 setTimeout 节流需要真实时间
        delete globalThis.__doubanFormData;
        delete globalThis.__doubanPhotoMap;
    });
    afterEach(() => {
        delete globalThis.__doubanFormData;
        delete globalThis.__doubanPhotoMap;
    });

    it('有序列表、引用、代码块均映射到正确 Draft.js block 类型', async () => {
        document.documentElement.innerHTML = makeDoubanPageHtml('333', 'ck3', 'tok3');

        const fetchImpl = vi.fn(async (url) => {
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({ r: 0, url: 'https://www.douban.com/note/333/' }),
                json: async () => ({ r: 0 }),
            };
        });

        const profile = await loadDoubanProfile();
        const md = [
            '1. 第一项',
            '2. 第二项',
            '',
            '> 这是引用',
            '',
            '```',
            'const x = 1;',
            '```',
        ].join('\n');

        const ctx = {
            title: '格式测试',
            content: md,
            draftOnly: true,
            outputFormat: 'markdown',
            preprocessConfig: null,
            imageSpec: null,
            imageSkip: [],
        };
        const js = buildPublishJs(ctx, profile.publish.toString(), profile.image.uploadFn.toString());
        const page = evalPage(fetchImpl);
        const result = await page.evaluate(js);

        expect(result.ok).toBe(true);

        // 从 fetch 调用中提取 note_text
        const autosaveCall = fetchImpl.mock.calls.find(([url]) => url === 'https://www.douban.com/j/note/autosave');
        expect(autosaveCall).toBeDefined();
        const body = autosaveCall[1].body;
        const params = new URLSearchParams(body);
        const draft = JSON.parse(params.get('note_text'));

        const types = draft.blocks.map(b => b.type);
        expect(types).toContain('ordered-list-item');
        expect(types).toContain('blockquote');
        expect(types).toContain('code-block');

        const codeBlock = draft.blocks.find(b => b.type === 'code-block');
        expect(codeBlock.text).toBe('const x = 1;');

        const quoteBlock = draft.blocks.find(b => b.type === 'blockquote');
        expect(quoteBlock.text).toBe('这是引用');
    });
});
