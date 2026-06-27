import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { readFile, stat } from 'node:fs/promises';
import { publishArticle } from '../_shared/article/publish.js';

// 雪球文章发布 profile
// 移植自 Wechatsync xueqiu 适配器（packages/core/src/adapters/platforms/xueqiu.ts）。
// 雪球原生吃 HTML（通过 Remarkable 渲染的简化 HTML），但 opencli 侧我们直接交
// markdown 给发布 API 前先在页面内做 MD→简化HTML 转换；由于 preprocessConfig.outputFormat
// 为 markdown，共享基建不做 DOM 预处理，只转存图片后在 publish 函数内自行渲染。
//
// 发布模型（已对照平台 bundle writeV2.d02e746530.js / main.b118d447b7.js 逐字核验）：
//   - 草稿（--draft）：POST /xq/statuses/draft/save.json（form），返回 {id}。
//   - 正式发布（默认）：在草稿之上提交一步——
//       ① POST draft/save.json 建草稿拿 draft_id；
//       ② GET /xq/provider/session/token.json?api_path=/statuses/update.json 取 CSRF session_token
//          （出处 main.js kr.csrf：get token → o.session_token=a.session_token → post）；
//       ③ POST /xq/statuses/update.json，body = 草稿 articleInfo 默认字段(gr) +
//          {title, status(正文HTML), draft_id, session_token, allow_reward, ai_disclose}。
//       成功响应含 .id；发布后雪球前端会自动删掉对应草稿。注意发布字段名是 status（非草稿的 text）。
export const xueqiuProfile = {
    home: 'https://mp.xueqiu.com/writeV2',
    outputFormat: 'markdown',
    // preprocessConfig 仅 html 平台有意义，雪球是 markdown，跳过 DOM 预处理。
    // 图片转存：下载字节 → multipart 上传（雪球不支持服务端自拉 URL，需传二进制）。
    image: {
        spec: {
            url: 'https://mp.xueqiu.com/xq/photo/upload.json',
            method: 'POST',
            bodyType: 'binary-multipart',
            fileField: 'file',
            fileName: 'image.jpg',
            // responsePath 指向上传后的 url 字段——但雪球需要拼接 url+filename，
            // 直接用 responsePath 拿到的 url 不完整，所以改用 uploadFn 处理。
            responsePath: 'url',
        },
        skip: ['xueqiu.com', 'imedao.com'],
        // 雪球图片上传返回 { url, filename }，完整地址需拼接；声明式 spec 只支持单字段，
        // 所以改用 uploadFn 在页面内完成下载+上传+拼接。
        uploadFn: async (src, _PP) => {
            // 1. 下载图片字节
            const imgResp = await fetch(src, { credentials: 'omit' });
            if (!imgResp.ok) throw new Error('图片下载失败: ' + src);
            const blob = await imgResp.blob();

            // 2. multipart 上传到雪球图床
            const fd = new FormData();
            fd.append('file', blob, 'image.jpg');

            const upResp = await fetch('https://mp.xueqiu.com/xq/photo/upload.json', {
                method: 'POST',
                credentials: 'include',
                body: fd,
            });
            const txt = await upResp.text();
            let res = null;
            try { res = JSON.parse(txt); } catch (e) {}
            if (!upResp.ok || !res || !res.url || !res.filename) {
                throw new Error('图片上传失败: ' + txt.slice(0, 200));
            }

            // 3. 拼接完整 URL（雪球返回 url 可能是 // 开头）
            const base = res.url.startsWith('//') ? 'https:' + res.url : res.url;
            return { url: base + '/' + res.filename };
        },
    },
    // 页面内登录检测：GET writeV2 页面，解析 window.UOM_CURRENTUSER。
    checkAuth: async (_PP) => {
        try {
            const resp = await fetch('https://mp.xueqiu.com/writeV2', { method: 'GET', credentials: 'include' });
            const html = await resp.text();
            const m = html.match(/window\.UOM_CURRENTUSER\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
            if (!m) return { isAuthenticated: false };
            let state = null;
            try { state = JSON.parse(m[1]); } catch (e) {}
            const cu = state && state.currentUser;
            if (!cu || !cu.id) return { isAuthenticated: false };
            const avatar = cu.photo_domain && cu.profile_image_url
                ? 'https:' + cu.photo_domain + (cu.profile_image_url.split(',')[0] || '')
                : '';
            return {
                isAuthenticated: true,
                userId: String(cu.id),
                username: cu.screen_name || '',
                avatar,
            };
        } catch (e) {
            return { isAuthenticated: false, error: String((e && e.message) || e) };
        }
    },
    // 页面内发布：将 markdown 内容转为雪球口味的简化 HTML。
    //   - draftOnly：POST draft/save.json 保存草稿（行为同原实现）。
    //   - 否则：先 save.json 拿 draft_id → 取 CSRF session_token → POST update.json 正式发布。
    // I = { title, content, markdown, html, draftOnly, params }，content 已完成图片转存。
    // I.params = { coverPic, showCoverPic, original, originalEventId, allowReward }（均可空，见 CLI 注释）。
    publish: async (I, _PP) => {
        const P = I.params || {};
        // 在页面内把 markdown 转成雪球口味简化 HTML
        // （雪球后端接收 HTML content 字段，非纯 markdown）
        let content = I.content;

        // 简单的 markdown → 雪球简化 HTML 转换（移植自 Wechatsync remarkable 规则）
        // 采用逐行处理方式，避免引入外部库
        const lines = content.split('\n');
        const htmlLines = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            // 代码块
            if (line.startsWith('```')) {
                let code = '';
                i++;
                while (i < lines.length && !lines[i].startsWith('```')) {
                    code += (code ? '\n' : '') + lines[i];
                    i++;
                }
                htmlLines.push('<pre><code>' + code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code></pre>');
                i++;
                continue;
            }
            // 标题（所有级别→ h4，移植 Wechatsync 规则）
            const heading = line.match(/^#{1,6}\s+(.*)/);
            if (heading) {
                htmlLines.push('<h4>' + heading[1] + '</h4>');
                i++;
                continue;
            }
            // 图片（需保持 class="ke_img"，移植 Wechatsync 规则）
            const imgMd = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
            if (imgMd) {
                htmlLines.push('<img src="' + imgMd[2] + '" alt="' + imgMd[1] + '" class="ke_img">');
                i++;
                continue;
            }
            // 分割线 → 跳过（移植 Wechatsync hr 规则）
            if (/^[-*_]{3,}\s*$/.test(line)) { i++; continue; }
            // 空行
            if (!line.trim()) { htmlLines.push(''); i++; continue; }
            // 普通行内处理（加粗→b、斜体→i）
            let p = line
                .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
                .replace(/\*([^*]+)\*/g, '<i>$1</i>')
                .replace(/`([^`]+)`/g, '<code>$1</code>');
            htmlLines.push('<p>' + p + '</p>');
            i++;
        }
        content = htmlLines.filter((l, idx, arr) => {
            // 去掉多余空行（连续空行只保留一个）
            return !(l === '' && idx > 0 && arr[idx - 1] === '');
        }).join('\n').trim();

        // 可选封面校验：cover_pic 必须是雪球自家图床地址（imedao/xueqiu），
        // 避免把外链直接当封面（雪球只认上传后的 url）。空串=无封面。
        const coverPic = typeof P.coverPic === 'string' ? P.coverPic.trim() : '';
        if (coverPic && !/(imedao\.com|xueqiu\.com)/.test(coverPic)) {
            return { ok: false, stage: 'cover', message: '封面图必须是雪球图床地址（含 imedao.com / xueqiu.com）；外链需先上传。当前：' + coverPic.slice(0, 120) };
        }

        // ── ① 建草稿：POST draft/save.json（草稿与发布都先走这一步拿 id）─────────
        const draftParams = new URLSearchParams({
            text: content,
            title: I.title,
            cover_pic: coverPic,
            flags: 'false',
            original_event: '',
            status_id: '',
            legal_user_visible: 'false',
            is_private: 'false',
        });
        const saveResp = await fetch('https://mp.xueqiu.com/xq/statuses/draft/save.json', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: draftParams,
        });
        const saveTxt = await saveResp.text();
        let saveRes = null;
        try { saveRes = JSON.parse(saveTxt); } catch (e) {}
        if (!saveResp.ok || !saveRes || !saveRes.id) {
            return {
                ok: false,
                stage: 'save',
                status: saveResp.status,
                message: (saveRes && saveRes.error_description) || saveTxt.slice(0, 300),
            };
        }
        const draftId = String(saveRes.id);

        // 仅草稿：到此为止，返回草稿链接（与原实现一致）。
        if (I.draftOnly) {
            return { ok: true, id: draftId, url: 'https://mp.xueqiu.com/write/draft/' + draftId, draft: true };
        }

        // ── 可选：校验 original_event_id（参与的原创活动事件，按 id 校验，禁 fallback）──
        let originalEventId = typeof P.originalEventId === 'string' ? P.originalEventId.trim() : '';
        let originalEventTag = '';
        let originalEventActive = true;
        if (originalEventId) {
            try {
                const er = await fetch('/xq/statuses/original/original_event.json?id=' + encodeURIComponent(originalEventId), { credentials: 'include' });
                const ej = await er.json();
                const ev = ej && ej.originalEvent;
                if (!ev || ev.id == null) {
                    return { ok: false, stage: 'original_event', message: '原创活动事件不存在：' + originalEventId + '（用 `xueqiu events` 列举热门事件）' };
                }
                if (ev.disabled) {
                    return { ok: false, stage: 'original_event', message: '原创活动事件已停用，不可参与：' + originalEventId };
                }
                originalEventTag = String(ev.tag || '');
            } catch (e) {
                return { ok: false, stage: 'original_event', message: '校验原创活动事件失败：' + String((e && e.message) || e) };
            }
        } else {
            // 不参与事件：active 置假并清空 id（对齐 bundle onPublish 的 `active||(id="")`）。
            originalEventActive = false;
        }

        // ── ② 取 CSRF session_token（每次现取，不缓存）──────────────────────────
        // 出处 main.js kr.csrf：GET session/token.json?api_path=/statuses/update.json → .session_token。
        let sessionToken = '';
        try {
            const tr = await fetch('/xq/provider/session/token.json?api_path=' + encodeURIComponent('/statuses/update.json'), { credentials: 'include' });
            const tj = await tr.json();
            sessionToken = tj && tj.session_token ? String(tj.session_token) : '';
        } catch (e) {
            return { ok: false, stage: 'csrf', message: '获取发布 CSRF token 失败：' + String((e && e.message) || e) };
        }
        if (!sessionToken) {
            return { ok: false, stage: 'csrf', message: '未取得发布 CSRF token（session_token 为空）' };
        }

        // ── ③ 正式发布：POST update.json ──────────────────────────────────────
        // body = 草稿 articleInfo 默认字段(gr) + {title, status(正文HTML), draft_id, session_token, allow_reward, ai_disclose}。
        // gr 默认值已对照 writeV2.js 逐字核验：cover_pic/show_cover_pic/original/industry_category_name/
        //   original_event_id/original_event_tag/original_event_active/legal_user_visible/is_private/legal_user_state。
        const showCoverPic = P.showCoverPic === false ? 'false' : 'true';
        const original = P.original === true ? 'true' : 'false';
        const allowReward = P.allowReward === true ? 'true' : 'false';
        const pubParams = new URLSearchParams({
            title: I.title,
            status: content,                       // 发布字段名是 status（非草稿的 text）
            draft_id: draftId,
            session_token: sessionToken,
            cover_pic: coverPic,
            show_cover_pic: showCoverPic,
            original,
            industry_category_name: '',            // 普通发文恒为空串（无可枚举来源，见 spec）
            original_event_id: originalEventActive ? originalEventId : '',
            original_event_tag: originalEventActive ? originalEventTag : '',
            original_event_active: originalEventActive ? 'true' : 'false',
            legal_user_visible: 'false',           // 公开文章
            is_private: 'false',
            legal_user_state: 'open',              // 公开
            allow_reward: allowReward,
        });
        // ai_disclose（AIGC 声明）：bundle 取 this.articleInfo.ai_disclose，未声明时为 undefined。
        // 普通发布不声明 AIGC，则该字段不传（对齐 undefined 语义，避免误传 "undefined"/空串）。
        const pubResp = await fetch('https://mp.xueqiu.com/xq/statuses/update.json', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: pubParams,
        });
        const pubTxt = await pubResp.text();
        let pubRes = null;
        try { pubRes = JSON.parse(pubTxt); } catch (e) {}
        if (!pubResp.ok || !pubRes || !pubRes.id) {
            return {
                ok: false,
                stage: 'publish',
                status: pubResp.status,
                message: (pubRes && (pubRes.error_description || pubRes.error_code)) || pubTxt.slice(0, 300),
            };
        }
        const postId = String(pubRes.id);
        // 拼可访问链接：雪球长文状态页为 https://xueqiu.com/<userId>/<statusId>。
        // userId 优先取响应里的 user_id/user.id，缺省则从写作页 UOM_CURRENTUSER 兜底。
        let uid = '';
        if (pubRes.user_id != null) uid = String(pubRes.user_id);
        else if (pubRes.user && pubRes.user.id != null) uid = String(pubRes.user.id);
        if (!uid) {
            try {
                const m = (document.documentElement.outerHTML || '').match(/UOM_CURRENTUSER\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
                if (m) { const cu = JSON.parse(m[1]).currentUser; if (cu && cu.id != null) uid = String(cu.id); }
            } catch (e) {}
        }
        const url = uid ? 'https://xueqiu.com/' + uid + '/' + postId : 'https://xueqiu.com/' + postId;
        return { ok: true, id: postId, url, draft: false };
    },
};

// ── 辅助函数（内联，无需 write-shared.js，避免引入知乎特有逻辑）────────────────

function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此命令需要 --execute 参数才能实际写入，防止误操作');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '不能同时使用 <text> 和 --file，请选一种');
    }
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', '文件不存在: ' + file); }
        if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', '路径必须是可读文本文件: ' + file);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', '文件读取失败: ' + file); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', '文件不是合法 UTF-8 文本: ' + file); }
    }
    if (!resolved.trim()) {
        throw new CliError('INVALID_INPUT', '正文不能为空');
    }
    return resolved;
}

function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

cli({
    site: 'xueqiu',
    name: 'article',
    access: 'write',
    description: '发布雪球文章（长文）。默认正式发布，加 --draft 仅存草稿。正文默认 Markdown，图片自动转存到雪球图床。',
    domain: 'mp.xueqiu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '正文（默认 Markdown；传 --html 则视为原始 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '把正文视为原始 HTML 而非 Markdown' },
        { name: 'cover-image', help: '封面图地址（必须是雪球图床 imedao.com/xueqiu.com 的 url；外链请先上传）。可空=无封面' },
        { name: 'no-cover', type: 'boolean', help: '有封面图时不在文章头部展示封面（show_cover_pic=false）' },
        { name: 'original', type: 'boolean', help: '声明原创（需账号有原创权限，否则发布会被拒）。默认非原创' },
        { name: 'original-event-id', help: '参与的原创活动/事件 id（精确校验，找不到/已停用报错）；合法值用 `xueqiu events` 列举。可空=不参与' },
        { name: 'allow-reward', type: 'boolean', help: '允许打赏。默认不允许' },
        { name: 'draft', type: 'boolean', help: '仅保存为草稿，不正式发布' },
        { name: 'execute', type: 'boolean', help: '实际执行写入；不加此参数命令拒绝写操作' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('雪球文章发布需要浏览器会话（browser session）');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title)
            throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft);

        const publishParams = {
            coverPic: typeof kwargs['cover-image'] === 'string' ? kwargs['cover-image'].trim() : '',
            showCoverPic: !kwargs['no-cover'],
            original: Boolean(kwargs.original),
            originalEventId: typeof kwargs['original-event-id'] === 'string' ? kwargs['original-event-id'].trim() : '',
            allowReward: Boolean(kwargs['allow-reward']),
        };

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: xueqiuProfile,
            publishParams,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = result.draft ? '已保存雪球文章草稿（需在写作页手动发布）' : '已正式发布雪球文章';
        if (upN || failN) {
            message += `；图片: ${upN} 张已转存${failN ? `，${failN} 张失败` : ''}`;
        }
        return buildResultRow(
            message,
            'article',
            '',
            result.draft ? 'draft' : 'created',
            { created_target: 'article:' + result.id, created_url: result.url },
        );
    },
});
