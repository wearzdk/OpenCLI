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

    // 页面内发布函数：获取 token → 建草稿（draftOnly）或正式发布。
    //
    // I = { title, content, draftOnly, params }，content 已完成图片转存（markdown）。
    // I.params = { tags:string[], cover?:string, channels?:string[] }：
    //   - tags：标签名数组；发布（draftOnly=false）时思否强制至少 1 个，逐个用
    //           GET /gateway/tag/{name} 解析成真实 tag id（精确匹配，找不到报错不 fallback）。
    //   - channels：频道名数组（可空）；用 GET /gateway/channels 列举后按名解析成 id。
    //   - cover：封面图思否图床 url（可空），由调用方先 /gateway/image 上传得到。
    //
    // 两条接口的出处（思否自家 Next.js bundle，已 re-fetch 核验，2026-06-27）：
    //   - 正式发布：POST /gateway/article（Api.postArticle，导出 M.fDS）；body 组装见 Write.js
    //     `{tags:I.value?.map(e=>e.id),title:T.value,text:Z,draft_id,...,log,...}`；成功 {data:{id}}。
    //   - 标签解析：GET /gateway/tag/{name}（Api.queryTagInfo，导出 M.sUO），返回 {tag:{id,name,...}}。
    //   - 频道列举：GET /gateway/channels（Api.getChannels）。
    //   - base 前缀 /gateway 来自 Request.send `let T="/gateway"+m`，鉴权头为 Token。
    publish: async (I, PP) => {
        const P = I.params || {};

        // ── 获取 session token（发布时再取一次，与图片上传解耦，避免 token 失效）──
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

        // ── 草稿分支：保持原有逻辑（已真机验证图片转存），思否 /gateway/draft 只建草稿 ──
        if (I.draftOnly) {
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
                draft: true,
                id: String(data.id),
                url: 'https://segmentfault.com/write?draftId=' + data.id,
            };
        }

        // ── 正式发布分支：POST /gateway/article ──────────────────────────────
        const authHeaders = {
            'Content-Type': 'application/json',
            'token': token,
            'accept': '*/*',
        };

        // 解析标签名 → tag id（思否发文强制至少 1 个标签；逐个精确解析，找不到报错不 fallback）
        const tagNames = Array.isArray(P.tags) ? P.tags.map((t) => String(t).trim()).filter(Boolean) : [];
        if (tagNames.length === 0) {
            return { ok: false, stage: 'tags', message: '思否发文必须至少指定 1 个标签（--tags），合法标签可用 `segmentfault tags <名称>` 校验' };
        }
        const tagIds = [];
        for (const name of tagNames) {
            let tagData;
            try {
                const tr = await fetch('https://segmentfault.com/gateway/tag/' + encodeURIComponent(name), {
                    credentials: 'include',
                    headers: authHeaders,
                });
                const tt = await tr.text();
                try { tagData = JSON.parse(tt); } catch (e) {
                    return { ok: false, stage: 'tags', status: tr.status, message: '解析标签「' + name + '」响应失败：' + tt.slice(0, 200) };
                }
            } catch (e) {
                return { ok: false, stage: 'tags', message: '解析标签「' + name + '」失败：' + String((e && e.message) || e) };
            }
            const tag = tagData && tagData.tag;
            if (!tag || tag.id == null) {
                return { ok: false, stage: 'tags', message: '思否上找不到标签「' + name + '」，请用 `segmentfault tags <名称>` 确认存在再发布' };
            }
            tagIds.push(tag.id);
        }

        // 解析频道名 → channel id（可空；按名精确匹配，找不到报错不 fallback）
        const channelNames = Array.isArray(P.channels) ? P.channels.map((c) => String(c).trim()).filter(Boolean) : [];
        const channelIds = [];
        if (channelNames.length > 0) {
            let list = [];
            try {
                const cr = await fetch('https://segmentfault.com/gateway/channels', {
                    credentials: 'include',
                    headers: authHeaders,
                });
                const ct = await cr.text();
                let cd;
                try { cd = JSON.parse(ct); } catch (e) {
                    return { ok: false, stage: 'channels', status: cr.status, message: '解析频道列表失败：' + ct.slice(0, 200) };
                }
                // 频道响应外形未抓到运行时样本，做宽松取数组（直接数组 / {data} / {rows} / {channels}）
                if (Array.isArray(cd)) list = cd;
                else if (cd && Array.isArray(cd.data)) list = cd.data;
                else if (cd && Array.isArray(cd.rows)) list = cd.rows;
                else if (cd && Array.isArray(cd.channels)) list = cd.channels;
                else list = [];
            } catch (e) {
                return { ok: false, stage: 'channels', message: '获取思否频道列表失败：' + String((e && e.message) || e) };
            }
            for (const cname of channelNames) {
                const hit = list.find((c) => c && String(c.name || c.title || c.text) === cname);
                if (!hit || hit.id == null) {
                    const avail = list.map((c) => (c && (c.name || c.title || c.text)) || '').filter(Boolean).join(' / ');
                    return { ok: false, stage: 'channels', message: '思否上找不到频道「' + cname + '」，可选：' + (avail || '（频道列表为空）') };
                }
                channelIds.push(hit.id);
            }
        }

        // 组装发布 body（字段名与前端一致；不传的可选字段一律省略，禁止 fallback 默认值）
        const articleBody = {
            title: I.title,
            text: I.content,
            tags: tagIds,
        };
        if (channelIds.length > 0) articleBody.channel = channelIds;
        if (P.cover) articleBody.cover = String(P.cover);

        const res = await fetch('https://segmentfault.com/gateway/article', {
            method: 'POST',
            credentials: 'include',
            headers: authHeaders,
            body: JSON.stringify(articleBody),
        });
        const text = await res.text();
        if (text === 'Unauthorized' || text.includes('禁言') || text.includes('锁定')) {
            return { ok: false, stage: 'publish', status: res.status, message: text === 'Unauthorized' ? '未授权，请检查登录态' : text };
        }

        let data;
        try { data = JSON.parse(text); } catch (e) {
            return { ok: false, stage: 'publish', status: res.status, message: '解析发布响应失败：' + text.slice(0, 200) };
        }

        // 失败响应：可能含 {isError, scene_id}（需人机验证）或各字段校验提示
        if (data && (data.isError || data.error || data.errno || data.scene_id)) {
            let msg = data.message || data.msg || data.error || '';
            if (data.scene_id) msg = (msg ? msg + '；' : '') + '思否要求人机验证（geetest），无法在自动化环境完成';
            return { ok: false, stage: 'publish', status: res.status, message: msg || ('发布失败：' + text.slice(0, 200)) };
        }

        // 成功外形：{data:{id}}（前端 e.data.id → 跳 /a/<id>）
        const articleId = data && data.data && data.data.id;
        if (articleId == null) {
            return { ok: false, stage: 'publish', status: res.status, message: (data && (data.message || data.msg)) || ('发布响应缺少文章 id：' + text.slice(0, 200)) };
        }

        return {
            ok: true,
            draft: false,
            id: String(articleId),
            url: 'https://segmentfault.com/a/' + articleId,
        };
    },
};

cli({
    site: 'segmentfault',
    name: 'article',
    access: 'write',
    description: '发布文章到思否（SegmentFault）。默认正式发布，加 --draft 仅存草稿。正文默认 Markdown；外链图片自动转存到思否图床。正式发布必须指定标签（--tags），合法标签用 `segmentfault tags <名称>` 校验、频道用 `segmentfault channels` 列举。',
    domain: 'segmentfault.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown；传 --html 则视为 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'tags', help: '标签名，逗号分隔（正式发布必填，至少 1 个）。合法标签用 `segmentfault tags <名称>` 校验；草稿可省略。' },
        { name: 'cover', help: '封面图思否图床 url（选填）。需先把图片上传到思否图床得到 url。' },
        { name: 'channels', help: '频道名，逗号分隔（选填）。合法值用 `segmentfault channels` 列举。' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿，不正式发布' },
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

        // 逗号分隔列表解析（去空白、去空项）
        const splitList = (v) =>
            typeof v === 'string'
                ? v.split(',').map((s) => s.trim()).filter(Boolean)
                : [];
        const tags = splitList(kwargs.tags);
        const channels = splitList(kwargs.channels);
        const cover = typeof kwargs.cover === 'string' ? kwargs.cover.trim() : '';

        // 正式发布前置校验：思否强制至少 1 个标签，缺失即报错（不 fallback）
        if (!draftOnly && tags.length === 0) {
            throw new CliError('INVALID_INPUT', '思否正式发布必须指定 --tags（至少 1 个标签）；合法标签用 `segmentfault tags <名称>` 校验，或加 --draft 只存草稿');
        }

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: segmentfaultProfile,
            publishParams: { tags, channels, cover },
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = result.draft ? '已保存到思否草稿箱（需在网页上手动发布）' : '已正式发布到思否';
        if (upN || failN) {
            message += `；图片：${upN} 张转存成功${failN ? `，${failN} 张失败` : ''}`;
        }
        return buildResultRow(
            message,
            'article',
            '',
            result.draft ? 'draft' : 'created',
            { created_target: (result.draft ? 'draft:' : 'article:') + result.id, created_url: result.url },
        );
    },
});
