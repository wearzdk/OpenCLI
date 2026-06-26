import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';

// ── 内联工具（替代 write-shared.js，segmentfault 是新站没有 write-shared）──────
import { readFile, stat } from 'node:fs/promises';

/**
 * 要求用户显式传 --execute，否则拒绝写操作。
 */
function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '本命令需要 --execute 才会真正发布，请确认后加上 --execute');
    }
}

/**
 * 解析正文来源：<text> 或 --file，互斥。
 */
async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '请只传 <text> 或 --file 之一，不能同时使用');
    }
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', `文件不存在：${file}`); }
        if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', `路径必须是可读文本文件：${file}`);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', `无法读取文件：${file}`); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', `文件编码不是 UTF-8：${file}`); }
    }
    if (!resolved.trim()) throw new CliError('INVALID_INPUT', '正文不能为空');
    return resolved;
}

/**
 * 构造返回结果行。
 */
function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

// ── 思否（SegmentFault）平台 profile ─────────────────────────────────────────
//
// 移植自 Wechatsync SegmentfaultAdapter：
//   - outputFormat: markdown（思否原生吃 Markdown，不需要 HTML 转换）
//   - 图片上传：先从写作页提取 session token，再 binary-multipart POST 到 /gateway/image
//   - 发布：POST /gateway/draft（建草稿），思否不提供直接发布接口，一律存草稿
//   - 因图片上传依赖 token（需在页面内先取），uploadFn 把两步内联在一起
//
// 注意：
//   - HEADER_RULES 在 Wechatsync 里用于注入 Origin/Referer，opencli 在已登录页面内跑
//     fetch，Origin/Referer 天然正确，故全部删除。
//   - 思否 /gateway/draft 只保存为草稿，不直接发布；draftOnly 参数保留但实际上恒为草稿。

export const segmentfaultProfile = {
    home: 'https://segmentfault.com/write',
    outputFormat: 'markdown',
    // markdown 平台不需要 preprocessConfig（预处理是 DOM 操作，对 markdown 无意义）

    // 图片转存：思否图片上传需要先获取 session token，再 binary-multipart 上传，
    // 两步不适合声明式 spec，用 uploadFn 实现。
    // 注意：uploadFn 是页面内函数，会被 .toString() 注入，只能用页面内全局。
    image: {
        skip: ['image-static.segmentfault.com', 'avatar-static.segmentfault.com'],
        uploadFn: async (src, PP) => {
            // 第一步：从写作页 HTML 提取 session token
            const tokenRes = await fetch('https://segmentfault.com/write', { credentials: 'include' });
            const html = await tokenRes.text();

            // 新版格式：serverData":{"Token":"xxx"
            let token = null;
            const newFmt = html.match(/serverData"\s*:\s*\{\s*"Token"\s*:\s*"([^"]+)"/);
            if (newFmt) {
                token = newFmt[1];
            } else {
                // 兼容旧版 window.g_initialProps
                const markStr = 'window.g_initialProps = ';
                const authIndex = html.indexOf(markStr);
                if (authIndex !== -1) {
                    const endIndex = html.indexOf(';\n\t</script>', authIndex);
                    if (endIndex !== -1) {
                        try {
                            const config = JSON.parse(html.substring(authIndex + markStr.length, endIndex));
                            token = config && config.global && config.global.sessionInfo && config.global.sessionInfo.key;
                        } catch (e) {}
                    }
                }
            }
            if (!token) throw new Error('获取思否 session token 失败');

            // 第二步：下载原图字节
            const imgRes = await fetch(src, { credentials: 'omit' });
            if (!imgRes.ok) throw new Error('下载图片失败：' + imgRes.status);
            const blob = await imgRes.blob();

            // 第三步：multipart 上传到思否图床
            const fd = new FormData();
            fd.append('image', blob);
            const upRes = await fetch('https://segmentfault.com/gateway/image', {
                method: 'POST',
                credentials: 'include',
                headers: { token: token },
                body: fd,
            });
            const text = await upRes.text();
            if (text === 'Unauthorized' || text.includes('禁言') || text.includes('锁定')) {
                throw new Error(text === 'Unauthorized' ? '未授权，请检查登录态' : text);
            }
            let res;
            try { res = JSON.parse(text); } catch (e) { throw new Error('图片上传失败：' + text); }

            // 新版返回：{ url: "/img/xxx", result: "https://..." }
            // 旧版返回：[0, url, id] 或 [1, error_message]
            let imageUrl = null;
            if (res && res.result) {
                imageUrl = res.result;
            } else if (Array.isArray(res)) {
                if (res[0] === 1) throw new Error(res[1] || '图片上传失败');
                imageUrl = res[1] || (res[2] ? 'https://image-static.segmentfault.com/' + res[2] : null);
            }
            if (!imageUrl) throw new Error('图片上传失败，服务端未返回 URL');
            return { url: imageUrl };
        },
    },

    // 页面内发布函数：获取 token → 建草稿。
    // 思否只提供草稿接口（/gateway/draft），发布需用户在网页上手动操作。
    // I = { title, content, draftOnly }，content 已完成图片转存（markdown）。
    publish: async (I, PP) => {
        // 获取 session token（发布时再取一次，与图片上传解耦，避免 token 失效）
        const tokenRes = await fetch('https://segmentfault.com/write', { credentials: 'include' });
        const html = await tokenRes.text();

        let token = null;
        const newFmt = html.match(/serverData"\s*:\s*\{\s*"Token"\s*:\s*"([^"]+)"/);
        if (newFmt) {
            token = newFmt[1];
        } else {
            const markStr = 'window.g_initialProps = ';
            const authIndex = html.indexOf(markStr);
            if (authIndex !== -1) {
                const endIndex = html.indexOf(';\n\t</script>', authIndex);
                if (endIndex !== -1) {
                    try {
                        const config = JSON.parse(html.substring(authIndex + markStr.length, endIndex));
                        token = config && config.global && config.global.sessionInfo && config.global.sessionInfo.key;
                    } catch (e) {}
                }
            }
        }
        if (!token) {
            return { ok: false, stage: 'token', status: 0, message: '获取思否 session token 失败，请确认已登录' };
        }

        // 发布草稿
        const postData = {
            title: I.title,
            tags: [],
            text: I.content,
            object_id: '',
            type: 'article',
        };
        const res = await fetch('https://segmentfault.com/gateway/draft', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'token': token,
                'accept': '*/*',
            },
            body: JSON.stringify(postData),
        });
        const text = await res.text();
        if (text === 'Unauthorized' || text.includes('禁言') || text.includes('锁定')) {
            return { ok: false, stage: 'publish', status: res.status, message: text === 'Unauthorized' ? '未授权' : text };
        }

        let data;
        try { data = JSON.parse(text); } catch (e) {
            return { ok: false, stage: 'publish', status: res.status, message: '解析响应失败：' + text.slice(0, 200) };
        }

        // 数组格式响应 [1, "error"] 或 [0, data]
        if (Array.isArray(data)) {
            if (data[0] === 1) {
                return { ok: false, stage: 'publish', status: res.status, message: data[1] || '发布失败' };
            }
            const d = data[1];
            if (d && d.id) {
                return { ok: true, draft: true, id: String(d.id), url: 'https://segmentfault.com/write?draftId=' + d.id };
            }
        }

        if (!data || !data.id) {
            const errorMsg = (data && (data.message || data.msg || data.error || data.errMsg)) || text.slice(0, 200);
            return { ok: false, stage: 'publish', status: res.status, message: errorMsg };
        }

        return {
            ok: true,
            draft: true,  // 思否只保存草稿，需在网页上手动发布
            id: String(data.id),
            url: 'https://segmentfault.com/write?draftId=' + data.id,
        };
    },
};

cli({
    site: 'segmentfault',
    name: 'article',
    access: 'write',
    description: '发布文章到思否（SegmentFault）。正文默认 Markdown；图片自动转存到思否图床；创建草稿后需在网页上手动发布。',
    domain: 'segmentfault.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown；传 --html 则视为 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿（思否默认行为，此参数保留兼容性）' },
        { name: 'execute', type: 'boolean', help: '实际执行发布。不加此参数时命令拒绝写操作。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('思否发布需要浏览器会话');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft);

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: segmentfaultProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = '已保存思否草稿（需在网页上手动发布）';
        if (upN || failN) {
            message += `；图片：${upN} 张转存成功${failN ? `，${failN} 张失败` : ''}`;
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
