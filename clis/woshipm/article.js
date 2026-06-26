import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';
import { checkLogin } from '../_shared/article/auth.js';
import { readFile, stat } from 'node:fs/promises';

// ── write-shared 内联（woshipm 无独立 write-shared.js）──────────────────────

function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此写操作需要 --execute 参数确认，未传则拒绝写入');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '正文来源只能二选一：<text> 或 --file，不能同时指定');
    }
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', `文件不存在：${file}`); }
        if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', `必须是普通文本文件：${file}`);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', `文件无法读取：${file}`); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
        catch { throw new CliError('INVALID_INPUT', `文件无法解码为 UTF-8：${file}`); }
    }
    if (!resolved.trim()) throw new CliError('INVALID_INPUT', '正文不能为空或仅有空白字符');
    return resolved;
}

function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

// ── 人人都是产品经理 profile ─────────────────────────────────────────────────
//
// 平台使用 HTML 格式；图片通过以下步骤上传：
//   1. 在发布函数（页面上下文）里从写作页 HTML 提取 jltoken
//   2. 用 jltoken 作为 Authorization Bearer 头，下载图片字节后 multipart POST 到
//      https://www.woshipm.com/tensorflow/upyun/upload
// 因为需要动态取 jltoken，且图片上传依赖它，所以使用自定义 uploadFn。

export const woshipmProfile = {
    home: 'https://www.woshipm.com/writing',
    outputFormat: 'html',
    // 预处理开关（对应 Wechatsync preprocessConfig）
    preprocessConfig: {
        removeEmptyLines: true,
    },
    // 图片转存：自定义 uploadFn——先从页面读取 jltoken，再下载字节并 multipart 上传
    image: {
        skip: ['woshipm.com', 'image.woshipm.com'],
        // uploadFn 是页面内函数，只能用页面内全局（fetch/document），不能 import/闭包。
        // src = 外链图片地址，PP = 页面运行时
        uploadFn: async (src, _PP) => {
            // 从当前页面提取 jltoken（写作页在 HTML 中内嵌 "jltoken":"xxx"）
            const pageHtml = document.documentElement.innerHTML || '';
            const jltokenMatch = pageHtml.match(/"jltoken"\s*:\s*"([^"]+)"/);
            const jltoken = jltokenMatch ? jltokenMatch[1] : '';

            // 从 URL 中取文件名
            let filename = 'image.png';
            try {
                const u = new URL(src);
                const parts = u.pathname.split('/');
                const last = parts[parts.length - 1];
                if (last) filename = last;
            } catch (e) {}

            // 下载图片字节
            const imgResp = await fetch(src, { credentials: 'omit' });
            if (!imgResp.ok) throw new Error('下载图片失败：' + imgResp.status + ' ' + src);
            const blob = await imgResp.blob();

            // 构建上传请求
            const formData = new FormData();
            formData.append('action', 'wpuf_insert_image');
            formData.append('name', filename);
            formData.append('files', blob, filename);

            const uploadHeaders = {};
            if (jltoken) {
                uploadHeaders['jlstar'] = 'Bearer ' + jltoken;
            }

            const upResp = await fetch('https://www.woshipm.com/tensorflow/upyun/upload', {
                method: 'POST',
                credentials: 'include',
                headers: uploadHeaders,
                body: formData,
            });

            const upData = await upResp.json();
            if (upData && upData.data && upData.data.length > 0 && upData.data[0].url) {
                return { url: upData.data[0].url };
            }
            throw new Error(upData.error || '图片上传失败：接口返回无 URL');
        },
    },

    // 登录检测（供 whoami 复用）——移植自 Wechatsync checkAuth()
    checkAuth: async (_PP) => {
        // 从写作页提取 jltoken 和 uid
        const pageResp = await fetch('https://www.woshipm.com/writing', {
            method: 'GET',
            credentials: 'include',
        });
        const pageText = await pageResp.text();

        const jltokenMatch = pageText.match(/"jltoken"\s*:\s*"([^"]+)"/);
        const jltoken = jltokenMatch ? jltokenMatch[1] : '';

        const uidMatch = pageText.match(/var\s+userSettings\s*=\s*\{[^}]*"uid"\s*:\s*"(\d+)"/);
        if (!uidMatch) {
            return { isAuthenticated: false };
        }
        const uid = uidMatch[1];

        // 调用 profile API 验证登录状态
        const profileResp = await fetch(
            'https://www.woshipm.com/api2/user/profile?uid=' + uid,
            {
                method: 'GET',
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            }
        );
        let profileData = null;
        try { profileData = await profileResp.json(); } catch (e) {}

        if (profileData && profileData.CODE === 200 && profileData.RESULT &&
            profileData.RESULT.userInfoVo && profileData.RESULT.userInfoVo.uid) {
            const info = profileData.RESULT.userInfoVo;
            return {
                isAuthenticated: true,
                userId: String(info.uid),
                username: info.nickName || '',
                avatar: info.avartar || '',
                // 暴露 jltoken 供后续使用（whoami 无需，但统一结构方便）
            };
        }
        return { isAuthenticated: false, error: '接口返回未登录（CODE: ' + (profileData && profileData.CODE) + '）' };
    },

    // 页面内发布函数——移植自 Wechatsync publish()
    // I = { title, content, draftOnly }，content 已完成预处理 + 图片转存
    publish: async (I, _PP) => {
        const content = I.content;

        // 创建草稿
        const createResp = await fetch('https://www.woshipm.com/wp-admin/admin-ajax.php', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: new URLSearchParams({
                action: 'add_draft',
                post_title: I.title,
                post_content: content,
            }),
        });

        const respText = await createResp.text();
        let createData = null;
        try { createData = JSON.parse(respText); } catch (e) {}

        if (!createResp.ok || !createData || !createData.post_id) {
            return {
                ok: false,
                stage: 'create',
                status: createResp.status,
                message: (createData && createData.error) || respText.slice(0, 300),
            };
        }

        const draftId = String(createData.post_id);
        const draftUrl = createData.url || ('https://www.woshipm.com/writing?pid=' + draftId);

        // 人人都是产品经理草稿创建即完成（平台不区分「草稿」和「发布」两步，发布在管理后台手动操作）
        // draftOnly 无论 true/false 均返回草稿链接，草稿创建成功即视为完成
        return { ok: true, draft: true, id: draftId, url: draftUrl };
    },
};

// ── CLI 注册 ─────────────────────────────────────────────────────────────────

cli({
    site: 'woshipm',
    name: 'article',
    access: 'write',
    description: '发布文章到人人都是产品经理（woshipm.com）。正文默认 Markdown，图片自动转存到站内图床。',
    domain: 'www.woshipm.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown；传 --html 则视为 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '把正文当 HTML 而非 Markdown 处理' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿，不发布（woshipm 目前仅支持草稿模式）' },
        { name: 'execute', type: 'boolean', help: '确认执行写操作。未传则拒绝写入。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('woshipm article 需要浏览器会话');
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
            profile: woshipmProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = '已创建草稿';
        if (upN || failN) {
            message += `（图片：${upN} 张已转存${failN ? `，${failN} 张失败` : ''}）`;
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
