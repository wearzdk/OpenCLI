import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';
import { checkLogin } from '../_shared/article/auth.js';
import { readFile, stat } from 'node:fs/promises';

// ── 慕课手记 profile ────────────────────────────────────────────────────────
// 移植自 Wechatsync ImoocAdapter（outputFormat: markdown，最薄）。
// 慕课只提供「存草稿」接口，没有一键发布接口，所以始终以草稿返回（draft: true）。
// 图片上传需要 File 对象 + 额外表单字段，装不进声明式 spec，用 uploadFn。
export const imoocProfile = {
    home: 'https://www.imooc.com/article',
    outputFormat: 'markdown',

    // ── 登录检测 ──────────────────────────────────────────────────────────────
    // 移植自 Wechatsync checkAuth()：调 JSONP 接口，解析 uid/nickname/img。
    // HEADER_RULES（Origin/Referer）在 opencli 页面内执行时天然满足，无需注入。
    checkAuth: async (PP) => {
        const resp = await fetch('https://www.imooc.com/u/card', { credentials: 'include' });
        let text = await resp.text();
        // 解析 JSONP：jsonpcallback({...}) → {...}
        text = text.replace(/^jsonpcallback\(/, '').replace(/\}\)$/, '}');
        let result;
        try { result = JSON.parse(text); } catch (e) { return { isAuthenticated: false, error: 'JSONP 解析失败：' + String(e && e.message || e) }; }
        if (!result || result.result !== 0) {
            return { isAuthenticated: false, error: (result && result.msg) || '未登录' };
        }
        return {
            isAuthenticated: true,
            userId: String(result.data.uid),
            username: result.data.nickname,
            avatar: result.data.img,
        };
    },

    // ── 图片转存 ─────────────────────────────────────────────────────────────
    // 移植自 uploadImageByUrl：下载图片字节 → multipart POST。
    // 需要 new File([blob], filename, {type}) 并附带额外字段（type/id/name/lastModifiedDate/size），
    // 声明式 binary-multipart spec 不支持此格式，故用 uploadFn。
    // 返回的 imgpath 可能是协议相对路径（//img.xxx），统一补 https:。
    image: {
        uploadFn: async (src, PP) => {
            const imageResp = await fetch(src, { credentials: 'omit' });
            if (!imageResp.ok) throw new Error('图片下载失败：HTTP ' + imageResp.status);
            const blob = await imageResp.blob();
            const filename = Date.now() + '.jpg';
            const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });

            const formData = new FormData();
            formData.append('photo', file, filename);
            formData.append('type', file.type);
            formData.append('id', 'WU_FILE_0');
            formData.append('name', filename);
            formData.append('lastModifiedDate', new Date().toString());
            formData.append('size', String(file.size));

            const resp = await fetch('https://www.imooc.com/article/ajaxuploadimg', {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });
            const res = await resp.json();
            if (!res || res.result !== 0) {
                throw new Error((res && res.msg) || '图片上传失败');
            }
            let imgUrl = res.data.imgpath;
            if (imgUrl && imgUrl.indexOf('//') === 0) {
                imgUrl = 'https:' + imgUrl;
            }
            return { url: imgUrl };
        },
        skip: ['img.imooc.com', 'imooc.com'],
    },

    // ── 发布 ─────────────────────────────────────────────────────────────────
    // 移植自 Wechatsync publish()：POST savedraft（始终保存为草稿）。
    // I.content 已完成图片转存，直接提交。
    // 慕课无「发布」独立接口，draftOnly 忽略（始终草稿），保持语义诚实，draft 始终 true。
    publish: async (I, PP) => {
        const resp = await fetch('https://www.imooc.com/article/savedraft', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                editor: '0',
                draft_id: '0',
                title: I.title,
                content: I.content,
            }),
        });
        if (!resp.ok) {
            const txt = await resp.text();
            return { ok: false, stage: 'savedraft', status: resp.status, message: txt.slice(0, 300) };
        }
        const res = await resp.json();
        if (!res || !res.data) {
            const raw = JSON.stringify(res).slice(0, 300);
            return { ok: false, stage: 'savedraft', status: resp.status, message: '保存草稿失败：' + raw };
        }
        const id = String(res.data);
        return {
            ok: true,
            id: id,
            url: 'https://www.imooc.com/article/draft/id/' + id,
            draft: true,
        };
    },
};

// ── requireExecute / resolvePayload / buildResultRow 内联精简版 ───────────────
// imooc 没有 write-shared.js，参照 zhihu/write-shared.js 内联关键三函数。
function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此命令需要 --execute 才会真正写入。不加 --execute 时仅做格式校验。');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '<text> 和 --file 不能同时使用');
    }
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', '文件不存在：' + file); }
        if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', '路径必须是可读文本文件：' + file);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', '文件读取失败：' + file); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', '文件不是有效 UTF-8：' + file); }
    }
    if (!resolved.trim()) throw new CliError('INVALID_INPUT', '正文不能为空');
    return resolved;
}

function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

// ── CLI 注册 ─────────────────────────────────────────────────────────────────
cli({
    site: 'imooc',
    name: 'article',
    access: 'write',
    description: '发布慕课手记文章（Markdown，始终存为草稿）。正文默认为 Markdown；外链图自动转存到慕课图床。',
    domain: 'www.imooc.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（Markdown，默认）' },
        { name: 'file', help: '正文文件路径（UTF-8，Markdown）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'draft', type: 'boolean', help: '（慕课始终草稿，此标志无额外效果）' },
        { name: 'execute', type: 'boolean', help: '真正执行写入，不加此标志时拒绝写操作' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('慕课手记发布需要浏览器会话');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly: true,   // 慕课始终草稿
            profile: imoocProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = '已保存慕课手记草稿';
        if (upN || failN) {
            message += `・图片：${upN} 张已转存${failN ? `，${failN} 张失败` : ''}`;
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

// imoocProfile 已在声明时 export，whoami.js 直接从此文件 import 即可。
