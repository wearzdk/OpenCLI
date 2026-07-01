// @ts-check
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { readFile, stat } from 'node:fs/promises';
import { publishArticle } from '../_shared/article/publish.js';

// ── Medium 发布 profile ──────────────────────────────────────────────────────
// 方案：Medium 内部端点（legacy delta editor + GraphQL），**非官方 API**——官方
// integration token 2023 起已停发新 token，早成死路。移植自开源 MIT 项目
// minanagehsalalma/medium-editor-mcp 的 legacy delta 编辑器实现，并据本机真实登录态
// 抓包核对（段落 type 枚举 / xsrf 来源 / 建稿→初始化→写delta→发布 全链路 200 通过）。
//
// 关键改造（相对参考实现）：参考在 Node 侧手动拼 Cookie 头 + 从 cookie 读 xsrf；我们
// 跑在**已登录的真实浏览器页**里，全部走同源 fetch(credentials:'include')，浏览器自动带
// sid/uid/xsrf 三个 HttpOnly 会话 cookie。xsrf **token** 无法从 document.cookie 读到
// （HttpOnly），改从编辑器页 HTML 内嵌的 "xsrfToken":"..." 提取，塞进 x-xsrf-token 头。
//
// 端点（全部 https://medium.com 同源）：
//   建稿   POST /new-story            → payload.value.id = postId
//   初始化 POST /p/{id}/deltas         {baseRev:-1, deltas: 草稿返回的 normalizingDeltas}
//   写正文 POST /p/{id}/deltas         {baseRev, deltas:[{type:1,index,paragraph:{...}}]}
//   传图   POST /_/upload?is2x=true    multipart uploadedFile → payload.value.{fileId,imgWidth,imgHeight}
//   标签   POST /_/graphql            SetPostTagsMutation(targetPostId, tagNames)
//   规范链 POST /_/graphql            UpdateCanonicalUrl(input:{postId,url})
//   发布   POST /p/{id}/publish        无 body
//   鉴权   POST /_/graphql            ViewerQuery { viewer { id name username } }
//
// 段落 type（真机回读坐实）：1=正文 2=大标题(H1 输入 12 会被归一为 2) 3=次级标题(且首块=文章标题)
//   4=副标题/图片 6=引用 8=代码 9=无序项 10=有序项 13=小标题(H4)；markup：1=粗 2=斜 3=链接。

export const mediumProfile = {
    home: 'https://medium.com/new-story',
    outputFormat: 'markdown',

    // ── 登录检测（whoami / login 复用）────────────────────────────────────────
    // GraphQL ViewerQuery：同源 fetch，仅凭会话 cookie 即可（无需 xsrf）。
    checkAuth: async (_PP) => {
        try {
            const resp = await fetch('https://medium.com/_/graphql', {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json', 'accept': 'application/json' },
                body: JSON.stringify({
                    operationName: 'ViewerQuery',
                    query: 'query ViewerQuery { viewer { id name username imageId } }',
                    variables: {},
                }),
            });
            const data = await resp.json();
            const v = data && data.data && data.data.viewer;
            if (v && v.id) {
                return {
                    isAuthenticated: true,
                    userId: v.id,
                    username: v.username || v.name || '',
                    avatar: v.imageId ? ('https://miro.medium.com/v2/resize:fill:96:96/' + v.imageId) : '',
                };
            }
            return { isAuthenticated: false };
        } catch (e) {
            return { isAuthenticated: false, error: String((e && e.message) || e) };
        }
    },

    // ── 发布函数（页面内序列化执行，带登录态）─────────────────────────────────
    // I = { title, content, markdown, html, draftOnly, params }
    // I.params = { tags: string[], subtitle?: string, canonicalUrl?: string }
    // content 即原始 Markdown（Medium 不走通用图片转存，图片在本函数内传 /_/upload）。
    publish: async (I, _PP) => {
        // —— 工具：剥 Medium JSON 前缀 ])}while(1);</x> ——
        const strip = (t) => t.replace(/^\s*\]\)\}while\(1\);(<\/x>)?/, '');

        // —— 取 xsrf token：编辑器页 HTML 内嵌 "xsrfToken":"..."（HttpOnly cookie 读不到）——
        const xm = document.documentElement.outerHTML.match(/"xsrfToken":"([^"]+)"/);
        const xsrf = xm ? xm[1] : null;
        if (!xsrf) {
            return { ok: false, stage: 'xsrf', message: '未能从编辑器页提取 xsrfToken（请确认已登录 medium.com 且停留在 /new-story）' };
        }

        const H = {
            'accept': 'application/json',
            'x-requested-with': 'XMLHttpRequest',
            'x-xsrf-token': xsrf,
        };
        // —— 统一请求（JSON 端点）——
        const api = async (path, method, body) => {
            const headers = Object.assign({}, H);
            if (body !== undefined) headers['content-type'] = 'application/json';
            const r = await fetch('https://medium.com' + path, {
                method: method || 'GET',
                credentials: 'include',
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
            let text = strip(await r.text());
            let json = null;
            try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
            return { status: r.status, json, text };
        };

        // —— 行内 Markdown → Medium markups（1=粗 2=斜 3=链接；行内代码退化为纯文本）——
        const renderInline = (text) => {
            const markups = [];
            let i = 0, out = '';
            const push = (v) => { if (v) out += v; };
            while (i < text.length) {
                const slice = text.slice(i);
                const m = slice.match(/^(\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|(https?:\/\/[^\s<]+[^\s<.,;:!?")\]]))/);
                if (!m) { push(text[i]); i += 1; continue; }
                const start = i + (m.index || 0);
                if (start > i) push(text.slice(i, start));
                const full = m[1];
                const s0 = out.length;
                if (m[2] !== undefined && m[3] !== undefined) {
                    push(m[2]);
                    markups.push({ type: 3, start: s0, end: out.length, href: m[3], title: '', rel: 'nofollow', anchorType: 0 });
                } else if (m[4] !== undefined) {
                    push(m[4]);
                    markups.push({ type: 1, start: s0, end: out.length });
                } else if (m[5] !== undefined) {
                    push(m[5]); // 行内代码：Medium delta 无行内 code markup，退化为纯文本
                } else if (m[6] !== undefined) {
                    push(m[6]);
                    markups.push({ type: 2, start: s0, end: out.length });
                } else if (m[7] !== undefined) {
                    push(m[7]);
                    markups.push({ type: 3, start: s0, end: out.length, href: m[7], title: '', rel: 'nofollow', anchorType: 0 });
                } else {
                    push(full);
                }
                i = start + full.length;
            }
            return { text: out, markups };
        };

        // —— Markdown → 段落块（type + text + markups；图片块带 imageUrl/imageAlt）——
        // 移植自参考 parseMarkdownToMediumBlocks（h1→12 h2→2 h3→3 h4→13，Medium 侧会归一）。
        const parseBlocks = (md) => {
            const TYPE = { paragraph: 1, h1: 12, h2: 2, h3: 3, h4: 13, blockquote: 6, code: 8, 'ul-li': 9, 'ol-li': 10 };
            const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
            const blocks = [];
            let para = [];
            let codeLang, codeLines = [], inCode = false;
            const pushPara = (t, typeName, lang) => {
                const nt = (t || '').trim();
                if (!nt) return;
                const type = TYPE[typeName] || TYPE.paragraph;
                const inl = type === TYPE.code ? { text: nt, markups: [] } : renderInline(nt);
                blocks.push(Object.assign({ type, text: inl.text, markups: inl.markups }, lang ? { codeLang: lang } : {}));
            };
            const flushPara = () => {
                if (!para.length) return;
                const text = para.join(' ').trim();
                para = [];
                if (!text) return;
                const h = text.match(/^(#{1,4})\s+(.*)$/);
                if (h) { pushPara(h[2].trim(), 'h' + h[1].length); return; }
                const q = text.match(/^>\s?(.*)$/);
                if (q) { pushPara(q[1].trim(), 'blockquote'); return; }
                const ol = text.match(/^\d+\.\s+(.*)$/);
                if (ol) { pushPara(ol[1].trim(), 'ol-li'); return; }
                const ul = text.match(/^[-*]\s+(.*)$/);
                if (ul) { pushPara(ul[1].trim(), 'ul-li'); return; }
                pushPara(text, 'paragraph');
            };
            const flushCode = () => {
                if (!codeLines.length) { codeLang = undefined; return; }
                blocks.push(Object.assign({ type: TYPE.code, text: codeLines.join('\n'), markups: [] }, codeLang ? { codeLang } : {}));
                codeLines = []; codeLang = undefined;
            };
            for (const line of lines) {
                const imgMd = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/i);
                const imgHtml = line.trim().match(/^<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>$/i);
                if (imgMd) { flushPara(); blocks.push({ image: true, imageUrl: imgMd[2], imageAlt: imgMd[1] || '' }); continue; }
                if (imgHtml) { flushPara(); const alt = line.match(/\balt=["']([^"']+)["']/i); blocks.push({ image: true, imageUrl: imgHtml[1], imageAlt: (alt && alt[1]) || '' }); continue; }
                const fence = line.match(/^```(\S+)?\s*$/);
                if (fence) {
                    if (inCode) { flushCode(); inCode = false; }
                    else { flushPara(); inCode = true; codeLang = fence[1] || undefined; }
                    continue;
                }
                if (inCode) { codeLines.push(line); continue; }
                if (!line.trim()) { flushPara(); continue; }
                if (/^(#{1,4})\s+/.test(line) || /^>\s?/.test(line) || /^\d+\.\s+/.test(line) || /^[-*]\s+/.test(line)) {
                    flushPara(); para.push(line); flushPara(); continue;
                }
                para.push(line.trim());
            }
            flushPara();
            if (inCode) flushCode();
            return blocks;
        };

        // —— 图片上传 /_/upload → { fileId, imgWidth, imgHeight } ——
        const uploadImage = async (src) => {
            let blob;
            const r = await fetch(src, { credentials: 'omit' });
            if (!r.ok) throw new Error('拉取图片失败 HTTP ' + r.status);
            blob = await r.blob();
            let name = 'image.png';
            try { const u = new URL(src); const seg = u.pathname.split('/').filter(Boolean).pop() || 'image.png'; name = /\.[a-z0-9]+$/i.test(seg) ? seg : seg + '.png'; } catch (e) { /* data: 等 */ }
            const form = new FormData();
            form.append('uploadedFile', blob, name);
            const up = await fetch('https://medium.com/_/upload?is2x=true', {
                method: 'POST', credentials: 'include',
                headers: { 'accept': 'application/json', 'x-requested-with': 'XMLHttpRequest', 'x-xsrf-token': xsrf },
                body: form,
            });
            const val = JSON.parse(strip(await up.text()));
            const v = (val && val.payload && val.payload.value) || {};
            if (!v.fileId || !v.imgWidth || !v.imgHeight) throw new Error('上传响应缺 fileId/尺寸');
            return { fileId: v.fileId, w: v.imgWidth, h: v.imgHeight };
        };

        const uploaded = [], failed = [];

        // ═══ 1. 建草稿 ═══
        const ns = await api('/new-story', 'POST', {});
        const nsp = (ns.json && ns.json.payload) || {};
        const postId = nsp.id || (nsp.value && nsp.value.id);
        if (!postId) return { ok: false, stage: 'create', status: ns.status, message: 'Medium 未返回草稿 postId：' + ns.text.slice(0, 160) };

        // ═══ 2. 读草稿初始态 + 初始化（在 rev -1 应用 normalizingDeltas）═══
        const d0 = await api('/_/api/posts/' + postId + '/draft');
        const p0 = (d0.json && d0.json.payload) || {};
        const normDeltas = Array.isArray(p0.normalizingDeltas) ? p0.normalizingDeltas : [];
        const rev0 = (p0.value && typeof p0.value.latestRev === 'number') ? p0.value.latestRev : 0;
        if (rev0 < 0 && normDeltas.length) {
            const initR = await api('/p/' + postId + '/deltas', 'POST', { baseRev: rev0, deltas: normDeltas });
            if (initR.status >= 400) return { ok: false, stage: 'init', status: initR.status, message: '初始化草稿失败' };
        }

        // ═══ 3. 取 baseRev ═══
        const pg = await api('/_/api/posts/' + postId);
        const pv = (pg.json && pg.json.payload && pg.json.payload.value) || {};
        const baseRev = typeof pv.latestRev === 'number' ? pv.latestRev : 0;

        // ═══ 4. 组装段落块：标题(type3, 首块=文章标题) + 副标题(type4) + 正文块 ═══
        const params = I.params || {};
        let bodyBlocks = parseBlocks(I.markdown || I.content || '');
        // 去掉与标题重复的首个 H1（避免正文里再出现一遍标题）
        if (I.title && bodyBlocks.length && !bodyBlocks[0].image && bodyBlocks[0].type === 12 && (bodyBlocks[0].text || '').trim() === I.title.trim()) {
            bodyBlocks = bodyBlocks.slice(1);
        }
        const head = [];
        if (I.title && I.title.trim()) head.push({ type: 3, text: I.title.trim(), markups: [] });
        if (params.subtitle && String(params.subtitle).trim()) head.push({ type: 4, text: String(params.subtitle).trim(), markups: [] });
        const allBlocks = head.concat(bodyBlocks);

        // ═══ 5. 块 → deltas（图片先传 /_/upload 再拼 image delta）═══
        const deltas = [];
        let idx = 0;
        for (const b of allBlocks) {
            if (b.image) {
                try {
                    const im = await uploadImage(b.imageUrl);
                    deltas.push({ type: 1, index: idx, paragraph: { type: 4, text: b.imageAlt || '', markups: [], layout: 1, metadata: { id: im.fileId, originalWidth: im.w, originalHeight: im.h } } });
                    uploaded.push(b.imageUrl);
                    idx += 1;
                } catch (e) {
                    failed.push({ src: b.imageUrl, error: String((e && e.message) || e) });
                    // 图片失败：跳过该块，不中断整篇发布
                }
                continue;
            }
            deltas.push(Object.assign({ type: 1, index: idx, paragraph: Object.assign({ type: b.type, text: b.text, markups: b.markups || [] }, b.codeLang ? { codeLang: b.codeLang } : {}) } ));
            idx += 1;
        }
        if (!deltas.length) return { ok: false, stage: 'content', message: '正文为空，无可写入的段落' };

        // ═══ 6. 写正文 ═══
        const wr = await api('/p/' + postId + '/deltas', 'POST', { baseRev, deltas });
        if (wr.status >= 400) return { ok: false, stage: 'write', status: wr.status, message: '写入正文失败：' + wr.text.slice(0, 160), uploaded, failed };

        // ═══ 7. 标签 / canonical（GraphQL，可选）═══
        const tags = Array.isArray(params.tags) ? params.tags.filter(Boolean).slice(0, 5) : [];
        if (tags.length) {
            const tg = await api('/_/graphql', 'POST', {
                operationName: 'SetPostTagsMutation',
                query: 'mutation SetPostTagsMutation($targetPostId: ID!, $tagNames: [String!]!) {\n  setPostTags(targetPostId: $targetPostId, tagNames: $tagNames) {\n    id\n  }\n}',
                variables: { targetPostId: postId, tagNames: tags },
            });
            if (tg.status >= 400 || (tg.json && tg.json.errors)) failed.push({ src: 'tags', error: '设置标签失败：' + (tg.text || '').slice(0, 120) });
        }
        if (params.canonicalUrl && String(params.canonicalUrl).trim()) {
            await api('/_/graphql', 'POST', {
                operationName: 'UpdateCanonicalUrl',
                query: 'mutation UpdateCanonicalUrl($input: UpdateCanonicalUrlInput!) {\n  updateCanonicalUrl(input: $input) {\n    __typename\n  }\n}',
                variables: { input: { postId, url: String(params.canonicalUrl).trim() } },
            });
        }

        // ═══ 8. 发布（draftOnly 则停在草稿）═══
        const draftUrl = 'https://medium.com/p/' + postId + '/edit';
        if (I.draftOnly) {
            return { ok: true, id: postId, url: draftUrl, draft: true, uploaded, failed };
        }
        const pub = await api('/p/' + postId + '/publish', 'POST', {});
        if (pub.status >= 400) return { ok: false, stage: 'publish', status: pub.status, message: '发布失败：' + pub.text.slice(0, 200), uploaded, failed };

        // 回查真实文章 URL
        const fin = await api('/_/api/posts/' + postId);
        const fv = (fin.json && fin.json.payload && fin.json.payload.value) || {};
        const url = fv.mediumUrl || (fv.uniqueSlug ? ('https://medium.com/p/' + postId) : ('https://medium.com/p/' + postId));
        return { ok: true, id: postId, url, draft: false, uploaded, failed };
    },
};

// checkAuth 供 whoami / login 复用。home 用轻量首页（GraphQL 探测无需编辑器页/xsrf），
// 不用发布档的 /new-story，避免读操作打开编辑器。
export const mediumAuthProfile = {
    home: 'https://medium.com/',
    checkAuth: mediumProfile.checkAuth,
};

// ── 本地小工具（与其它 article.js 一致）─────────────────────────────────────
function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此命令需要 --execute 参数才能执行写操作');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) throw new CliError('INVALID_INPUT', '不能同时指定正文参数和 --file，请二选一');
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', '文件不存在: ' + file); }
        if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', '必须是可读的文本文件: ' + file);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', '无法读取文件: ' + file); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
        catch { throw new CliError('INVALID_INPUT', '文件必须是 UTF-8 编码: ' + file); }
    }
    if (!resolved.trim()) throw new CliError('INVALID_INPUT', '正文不能为空');
    return resolved;
}

function buildResultRow(message, target, url, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: 'article', target, ...extra }];
}

// ── CLI 注册 ─────────────────────────────────────────────────────────────
cli({
    site: 'medium',
    name: 'article',
    access: 'write',
    description: '发布 Medium 文章（走 medium.com 内部编辑器端点，非官方 API）。默认正式发布；加 --draft 仅存草稿。正文 Markdown，图片自动转存 Medium 图床。可选 --tags/--subtitle/--canonical-url。',
    domain: 'medium.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题（作为 Medium 文章标题）' },
        { name: 'text', positional: true, help: '文章正文（Markdown）' },
        { name: 'file', help: '正文文件路径（UTF-8，Markdown）' },
        { name: 'tags', help: 'Medium 话题标签，逗号分隔，最多 5 个（如 "AI,Programming,Open Source"）' },
        { name: 'subtitle', help: '副标题（可选，显示在标题下方）' },
        { name: 'canonical-url', help: '原文规范链接（可选，内容首发别处时填，避免 SEO 重复）' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿，不正式发布' },
        { name: 'execute', type: 'boolean', help: '确认执行写操作。不加此参数则拒绝写入。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('Medium 文章发布需要浏览器会话');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft);
        const tags = String(kwargs.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const publishParams = {
            tags,
            subtitle: typeof kwargs.subtitle === 'string' ? kwargs.subtitle : '',
            canonicalUrl: typeof kwargs['canonical-url'] === 'string' ? kwargs['canonical-url'] : '',
        };

        const result = await publishArticle(page, {
            title,
            body,
            format: 'markdown',
            draftOnly,
            profile: mediumProfile,
            publishParams,
        });

        const upN = (result.images.uploaded.length) | 0;
        const failN = (result.images.failed.length) | 0;
        let message = result.draft ? 'Medium 草稿已保存（可在编辑器内手动发布）' : 'Medium 文章已正式发布';
        if (upN || failN) message += '；图片：' + upN + ' 张已转存' + (failN ? '，' + failN + ' 张失败' : '');
        return buildResultRow(message, '', result.url, result.draft ? 'draft' : 'publish', {
            created_target: 'article:' + result.id,
            created_url: result.url,
        });
    },
});
