// @ts-check
import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { readFile, stat } from 'node:fs/promises';
import { gotoWritePage } from '../_shared/article/publish.js';
import { normalizeContent } from '../_shared/article/format.js';
import { markdownToDraftState } from '../_shared/article/douban-md2draft.js';

// ── 辅助：requireExecute / resolvePayload / buildResultRow（内联，豆瓣无 write-shared.js）──

/**
 * 若未传 --execute，拒绝写操作。
 * @param {Record<string,unknown>} kwargs
 */
function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此命令需要 --execute 才会真正发布，去掉 --execute 不会写入任何数据。');
    }
}

/**
 * 从 kwargs 取正文（text 参数 或 --file 文件）。
 * @param {Record<string,unknown>} kwargs
 * @returns {Promise<string>}
 */
async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) throw new CliError('INVALID_INPUT', 'text 和 --file 不能同时使用');
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', `文件未找到：${file}`); }
        if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', `必须是可读文本文件：${file}`);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', `文件无法读取：${file}`); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', `文件不是合法 UTF-8 文本：${file}`); }
    }
    if (!resolved.trim()) throw new CliError('INVALID_INPUT', '正文不能为空');
    return resolved;
}

/**
 * 组装结果行（遵循 opencli 列表返回格式）。
 * @returns {Array<Record<string,unknown>>}
 */
function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

/**
 * 给 markdown-draft-js 产出的 blocks 补齐 Draft.js 必需字段（key/depth/data 等）。
 * @param {{ blocks: Array<any>, entityMap: Record<string, any> }} state
 */
function normalizeDraftState(state) {
    let i = 0;
    for (const b of state.blocks || []) {
        if (b.key == null) b.key = 'b' + (i++).toString(36);
        if (b.depth == null) b.depth = 0;
        if (!b.inlineStyleRanges) b.inlineStyleRanges = [];
        if (!b.entityRanges) b.entityRanges = [];
        if (!b.data) b.data = {};
    }
    if (!state.entityMap) state.entityMap = {};
    return state;
}

/**
 * 拼出豆瓣发布的单次 evaluate 源码。
 *
 * 豆瓣 2026 改版后日记走新的 rexxar API（老 /j/note/* 已 404）：
 *   - 图片上传：POST https://www.douban.com/j/group/topic/add_photo
 *     FormData { ck, image_file, primary_color, upload_auth_token }
 *     （ck 取自 cookie；upload_auth_token 取自 window.__INIT_STATE__）→ { r:0, photo:{ url, src, raw_src, id } }
 *   - 草稿（私有）：POST https://m.douban.com/rexxar/api/v2/dwarf/drafts
 *     { draft_props: JSON.stringify({ title, content:{blocks,entityMap}, image_ids:[], subtype:'note' }) }
 *   - 发布（公开）：POST https://m.douban.com/rexxar/api/v2/topic/post
 *     { title, content: JSON(stringified DraftJS), image_ids, subtype:'note', accessible:'public', ... }
 *
 * 正文是 Draft.js ContentState：转换器已在 Node 侧产出（图片为占位 IMAGE 实体，data.url=外链），
 * 这里在页面内把外链图片下载字节、上传到豆瓣图床、回填实体 data + image_ids，再提交。
 * @param {{ title: string, draftState: object, draftOnly: boolean }} ctx
 */
function buildDoubanPublishJs(ctx) {
    return '(async () => {\n'
        + 'const I = ' + JSON.stringify(ctx) + ';\n'
        + 'const ck = (document.cookie.match(/\\bck="?([^";]+)"?/) || [])[1] || "";\n'
        + 'const uploadAuthToken = (window.__INIT_STATE__ && window.__INIT_STATE__.upload_auth_token) || "";\n'
        + 'const draft = I.draftState;\n'
        + 'const em = draft.entityMap || {};\n'
        + 'const imageIds = []; const uploaded = []; const failed = [];\n'
        + 'const skipRe = /doubanio\\.com|douban\\.com/;\n'
        + 'for (const k of Object.keys(em)) {\n'
        + '  const ent = em[k];\n'
        + '  if (!ent || ent.type !== "IMAGE") continue;\n'
        + '  const url = ent.data && ent.data.url;\n'
        + '  if (!url) continue;\n'
        + '  if (skipRe.test(url)) { if (ent.data.id) imageIds.push(ent.data.id); continue; }\n'
        + '  try {\n'
        + '    const ir = await fetch(url, { credentials: "omit" });\n'
        + '    if (!ir.ok) throw new Error("下载失败 HTTP " + ir.status);\n'
        + '    const blob = await ir.blob();\n'
        + '    if (!uploadAuthToken) throw new Error("未获取上传凭证 upload_auth_token（请确认在编辑器页面已登录）");\n'
        + '    const fd = new FormData();\n'
        + '    fd.append("ck", ck);\n'
        + '    fd.append("image_file", blob, "image.jpg");\n'
        + '    fd.append("primary_color", "");\n'
        + '    fd.append("upload_auth_token", uploadAuthToken);\n'
        + '    const ur = await fetch("https://www.douban.com/j/group/topic/add_photo", { method: "POST", credentials: "include", body: fd });\n'
        + '    if (!ur.ok) throw new Error("上传 HTTP " + ur.status);\n'
        + '    const ures = await ur.json();\n'
        + '    const photo = ures && ures.photo;\n'
        + '    if (!photo || !photo.url) throw new Error("无 photo.url：" + JSON.stringify(ures).slice(0, 150));\n'
        + '    ent.data = { id: photo.id, src: photo.url, thumb: photo.thumb || photo.url, url: photo.url, width: photo.width || 0, height: photo.height || 0 };\n'
        + '    if (photo.id != null && photo.id !== "") imageIds.push(photo.id);\n'
        + '    uploaded.push(url);\n'
        + '  } catch (e) { failed.push({ src: url, error: String((e && e.message) || e) }); }\n'
        + '}\n'
        + 'const contentObj = { blocks: draft.blocks, entityMap: draft.entityMap };\n'
        + 'let resp, data = null, id = "", noteUrl = "";\n'
        + 'if (I.draftOnly) {\n'
        + '  const body = { draft_props: JSON.stringify({ title: I.title, content: contentObj, image_ids: imageIds, subtype: "note" }) };\n'
        + '  resp = await fetch("https://m.douban.com/rexxar/api/v2/dwarf/drafts", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });\n'
        + '  const t = await resp.text(); try { data = JSON.parse(t); } catch (e) {}\n'
        + '  if (!resp.ok) return { ok: false, stage: "draft", status: resp.status, message: t.slice(0, 300), uploaded, failed };\n'
        + '  id = (data && (data.id != null ? data.id : data.draft_id)) || "";\n'
        + '  noteUrl = "https://www.douban.com/note/create";\n'
        + '} else {\n'
        + '  const body = { title: I.title, content: JSON.stringify(contentObj), image_ids: imageIds.join(","), topic_tag_ids: "", interest_tags: "", is_event: false, subtype: "note", accessible: "public", explanation_types: "", send_status: true, original: false, is_activity_rule: false, enable_item_tag: false };\n'
        + '  resp = await fetch("https://m.douban.com/rexxar/api/v2/topic/post", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });\n'
        + '  const t = await resp.text(); try { data = JSON.parse(t); } catch (e) {}\n'
        + '  if (!resp.ok) return { ok: false, stage: "publish", status: resp.status, message: t.slice(0, 300), uploaded, failed };\n'
        + '  id = (data && data.id) || "";\n'
        + '  noteUrl = (data && data.url) || ("https://www.douban.com/note/" + id + "/");\n'
        + '}\n'
        + 'return { ok: true, id: String(id), url: noteUrl, draft: !!I.draftOnly, uploaded, failed };\n'
        + '})()';
}

// 豆瓣编辑器地址：/note/create 会 302 到 /topic/create?subtype=note（React SPA，含 __INIT_STATE__）
const DOUBAN_HOME = 'https://www.douban.com/note/create';
const DOUBAN_ORIGIN_RE = '^https?://([^/]*\\.)?douban\\.com(/|$)';

export const __test__ = { normalizeDraftState, buildDoubanPublishJs };

// ── CLI 注册 ─────────────────────────────────────────────────────────────────────

cli({
    site: 'douban',
    name: 'article',
    access: 'write',
    description: '发布豆瓣日记。正文默认 Markdown，图片自动转存到豆瓣图床；正文以 Draft.js 提交到新版 rexxar 接口。',
    domain: 'www.douban.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '日记标题' },
        { name: 'text', positional: true, help: '正文（Markdown 格式；也可用 --file）' },
        { name: 'file', help: '正文文件路径（UTF-8，Markdown 格式）' },
        { name: 'html', type: 'boolean', help: '把正文当 HTML 处理而不是 Markdown' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿（私有，不公开发布）' },
        { name: 'execute', type: 'boolean', help: '真正执行写操作；不带此参数命令会拒绝写入' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('豆瓣 article 命令需要浏览器会话（Browser session required）');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft);

        // Node 侧：归一为 Markdown → Draft.js ContentState（图片为占位 IMAGE 实体）。
        const norm = normalizeContent(body, { format: kwargs.html ? 'html' : 'markdown' });
        const draftState = normalizeDraftState(markdownToDraftState(norm.markdown));

        // 落到豆瓣编辑器页（带 __INIT_STATE__.upload_auth_token），再单次 evaluate 转存 + 提交。
        await gotoWritePage(page, DOUBAN_HOME, DOUBAN_ORIGIN_RE);
        const r = await page.evaluate(buildDoubanPublishJs({ title, draftState, draftOnly }));

        if (!r || !r.ok) {
            const stage = (r && r.stage) || 'unknown';
            const msg = (r && r.message) || '未知错误';
            throw new CommandExecutionError(`豆瓣发布失败（${stage}${r && r.status ? ' HTTP ' + r.status : ''}）：${msg}`);
        }

        const upN = (r.uploaded && r.uploaded.length) | 0;
        const failN = (r.failed && r.failed.length) | 0;
        let message = draftOnly ? '已保存豆瓣日记草稿（私有，可在编辑器草稿箱查看）' : '已发布豆瓣日记';
        if (upN || failN) {
            message += `・图片：${upN} 张已转存${failN ? `，${failN} 张失败` : ''}`;
        }
        return buildResultRow(
            message,
            'article',
            '',
            draftOnly ? 'draft' : 'created',
            { created_target: 'note:' + r.id, created_url: r.url },
        );
    },
});
