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
// 注意：雪球的「发布」其实是「保存草稿」——平台 API 只有 save.json，不区分草稿/发布。
// 文章保存后需用户在 https://mp.xueqiu.com/write/draft/<id> 手动点发布；
// draftOnly=false 时同样保存草稿（行为相同），返回注释说明。
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
    // 页面内发布：将 markdown 内容转为雪球口味的简化 HTML，然后 POST 保存草稿。
    // 雪球 API 只有「保存草稿」，无独立「发布」接口；真正发布需用户在写作页手动操作。
    publish: async (I, _PP) => {
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

        // POST 保存草稿
        const params = new URLSearchParams({
            text: content,
            title: I.title,
            cover_pic: '',
            flags: 'false',
            original_event: '',
            status_id: '',
            legal_user_visible: 'false',
            is_private: 'false',
        });

        const resp = await fetch('https://mp.xueqiu.com/xq/statuses/draft/save.json', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params,
        });

        const txt = await resp.text();
        let res = null;
        try { res = JSON.parse(txt); } catch (e) {}

        if (!resp.ok || !res || !res.id) {
            return {
                ok: false,
                stage: 'save',
                status: resp.status,
                message: (res && res.error_description) || txt.slice(0, 300),
            };
        }

        const id = String(res.id);
        // 雪球草稿链接（保存后需在此页手动发布）
        const url = 'https://mp.xueqiu.com/write/draft/' + id;
        return { ok: true, id, url, draft: true };
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
    description: '发布雪球文章（长文/草稿）。正文默认为 Markdown，图片自动转存到雪球图床。注意：雪球 API 只提供草稿保存，发布需在写作页手动操作。',
    domain: 'mp.xueqiu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '正文（默认 Markdown；传 --html 则视为原始 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '把正文视为原始 HTML 而非 Markdown' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿（雪球本身就只能保存草稿，此参数效果相同）' },
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

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: xueqiuProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = '已保存雪球文章草稿（需在写作页手动发布）';
        if (upN || failN) {
            message += `；图片: ${upN} 张已转存${failN ? `，${failN} 张失败` : ''}`;
        }
        return buildResultRow(
            message,
            'article',
            '',
            'draft',
            { created_target: 'article:' + result.id, created_url: result.url },
        );
    },
});
