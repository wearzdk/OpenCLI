import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';
import { readFile, stat } from 'node:fs/promises';

// ── 本地辅助（仿 zhihu/write-shared.js，仅在 Node 侧用）────────────────────

function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此写操作需要 --execute 才会真正提交');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '正文和 --file 只能选一个');
    }
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch {
            throw new CliError('INVALID_INPUT', `文件不存在：${file}`);
        }
        if (!fileStat.isFile()) {
            throw new CliError('INVALID_INPUT', `--file 必须是可读的文本文件：${file}`);
        }
        let raw;
        try { raw = await readFile(file); } catch {
            throw new CliError('INVALID_INPUT', `文件无法读取：${file}`);
        }
        try {
            resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        } catch {
            throw new CliError('INVALID_INPUT', `文件无法以 UTF-8 解码：${file}`);
        }
    }
    if (!resolved.trim()) {
        throw new CliError('INVALID_INPUT', '正文不能为空');
    }
    return resolved;
}

function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

// ── B站专栏 profile ──────────────────────────────────────────────────────────
//
// 移植自 Wechatsync BilibiliAdapter（packages/core/src/adapters/platforms/bilibili.ts）。
// 原适配器通过 declarativeNetRequest 注入 Origin/Referer；opencli 在用户已登录的页面
// 标签内跑，同源天然携带 cookie，故删除所有 HEADER_RULES / withHeaderRules / runtime.fetch。
//
// B站专栏（opus/article）写作页：https://member.bilibili.com/platform/upload/text
// 草稿 API：POST /x/article/creative/draft/addupdate（仅存草稿；B站没有「一步发布」接口，
// 长文专栏必须在创作中心手动审核发布，故 draftOnly 无论传何值，均落到草稿状态）
// 图片上传：下载字节 → multipart POST /x/article/creative/article/upcover

export const bilibiliArticleProfile = {
    home: 'https://member.bilibili.com/platform/upload/text',
    // 确认落到创作中心域（member.bilibili.com 或 passport.bilibili.com 重定向后回来）
    originRe: '^https?://([^/]*\\.)?bilibili\\.com(/|$)',
    outputFormat: 'html',
    // 移植自 Wechatsync BilibiliAdapter.preprocessConfig
    preprocessConfig: {
        removeLinks: true,
    },
    image: {
        // B站图片上传须下载字节后 multipart POST，故用 uploadFn（多步，无法用声明式 spec）。
        // 使用 /x/article/creative/article/upcover 接口，需要 CSRF token（bili_jct cookie）。
        uploadFn: async (src, PP) => {
            // 从 cookie 取 CSRF token（页面内环境）
            var csrf = PP.cookie('bili_jct');
            if (!csrf) {
                throw new Error('未找到 bili_jct CSRF token，请确认已登录 B站');
            }
            // 下载图片字节
            var imgResp = await fetch(src, { credentials: 'omit' });
            if (!imgResp.ok) {
                throw new Error('图片下载失败（HTTP ' + imgResp.status + '）：' + src.slice(0, 120));
            }
            var blob = await imgResp.blob();
            // 构造 multipart 上传
            var fd = new FormData();
            fd.append('binary', blob, 'image.jpg');
            fd.append('csrf', csrf);
            var upResp = await fetch('https://api.bilibili.com/x/article/creative/article/upcover', {
                method: 'POST',
                credentials: 'include',
                body: fd,
            });
            var upText = await upResp.text();
            var upData = null;
            try { upData = JSON.parse(upText); } catch (e) {}
            if (!upResp.ok || !upData || upData.code !== 0 || !upData.data || !upData.data.url) {
                throw new Error('B站图片上传失败：' + (upData && upData.message ? upData.message : upText.slice(0, 150)));
            }
            return { url: upData.data.url };
        },
        // 跳过已在 B站 CDN 上的图片，不重复转存
        skip: ['hdslb.com', 'bilibili.com', 'biliimg.com'],
    },
    // 页面内发布函数：调 B站专栏草稿 API。
    // B站专栏没有「直接发布」接口，长文必须在创作中心通过审核后手动发布，
    // 故此处始终落到草稿（tid=4 = 综合分区）。draftOnly 无论为 true/false 均保存草稿。
    publish: async (I, PP) => {
        var csrf = PP.cookie('bili_jct');
        if (!csrf) {
            return { ok: false, stage: 'csrf', status: 0, message: '未找到 bili_jct CSRF token，请确认已登录 B站' };
        }

        // 构造表单（postForm 等价：URLSearchParams）
        var params = new URLSearchParams();
        params.append('tid', '4');                // 4 = 综合分区
        params.append('title', I.title);
        params.append('content', I.content);
        params.append('csrf', csrf);
        params.append('save', '0');               // save=0 表示保存草稿
        params.append('pgc_id', '0');

        var resp = await fetch('https://api.bilibili.com/x/article/creative/draft/addupdate', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://member.bilibili.com',
                'Referer': 'https://member.bilibili.com/',
            },
            body: params.toString(),
        });
        var respText = await resp.text();
        var data = null;
        try { data = JSON.parse(respText); } catch (e) {}

        if (!resp.ok || !data) {
            return { ok: false, stage: 'draft', status: resp.status, message: respText.slice(0, 300) };
        }
        if (data.code !== 0 || !data.data || !data.data.aid) {
            return { ok: false, stage: 'draft', status: resp.status, message: (data.message || '保存草稿失败') + '（code=' + data.code + '）' };
        }

        var aid = String(data.data.aid);
        var draftUrl = 'https://member.bilibili.com/platform/upload/text/edit?aid=' + aid;

        // B站专栏必须在创作中心手动发布，此处始终返回草稿
        return { ok: true, draft: true, id: aid, url: draftUrl };
    },
};

// ── CLI 注册 ─────────────────────────────────────────────────────────────────

cli({
    site: 'bilibili',
    name: 'article',
    access: 'write',
    description: '发布 B站专栏长文（opus/article）。正文默认 Markdown，图片自动转存至 B站图床，始终以草稿保存（需在创作中心手动发布）。',
    domain: 'member.bilibili.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '正文（默认 Markdown；加 --html 则作 HTML 处理）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿（B站专栏始终如此，此参数保留兼容性）' },
        { name: 'execute', type: 'boolean', help: '实际提交。不加此参数时命令拒绝写入。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('B站专栏发布需要浏览器会话');
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
            profile: bilibiliArticleProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = '已保存 B站专栏草稿（需在创作中心手动发布）';
        if (upN || failN) {
            message += `·图片：${upN} 张已转存${failN ? `，${failN} 张失败` : ''}`;
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
