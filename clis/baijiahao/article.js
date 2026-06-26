import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';
import { readFile, stat } from 'node:fs/promises';

// ── 工具函数（内联，本站无 write-shared.js）──────────────────────────────────

function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此百家号写操作需要 --execute 参数才能真正发布');
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
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', `找不到文件: ${file}`); }
        if (!fileStat.isFile()) { throw new CliError('INVALID_INPUT', `--file 必须是可读文本文件: ${file}`); }
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', `文件无法读取: ${file}`); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', `文件必须是 UTF-8 编码: ${file}`); }
    }
    if (!resolved.trim()) { throw new CliError('INVALID_INPUT', '正文不能为空'); }
    return resolved;
}

function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

// ── 百家号 profile ────────────────────────────────────────────────────────────

/**
 * 百家号 profile
 *
 * 移植自 Wechatsync BaijiahaoAdapter（baijiahao.ts）。
 * - 格式：HTML（outputFormat: 'html'）
 * - preprocessConfig：Wechatsync 原适配器 preprocessConfig 仅声明了 outputFormat，
 *   无其他预处理开关，百家号编辑器对 HTML 接受度较高，不需要额外裁剪。
 * - 图片转存：下载字节 → multipart POST 上传（binary-multipart）。
 *   上传接口 /pcui/picture/uploadproxy 需要 FormData，故使用 uploadFn 实现。
 * - 发布：先从编辑页 HTML 里抓 window.__BJH__INIT__AUTH__ token，
 *   再 POST /pcui/article/save，返回 JSONP（需剥掉 `bjhdraft(...)` 包装）。
 *   Wechatsync 原始实现只保存草稿（draftOnly: true 固定），这里支持可选直接发布。
 */
export const baijiahaoProfile = {
    home: 'https://baijiahao.baidu.com',
    outputFormat: 'html',
    // Wechatsync 原适配器 preprocessConfig 只声明了 outputFormat，无其他开关。
    // 这里不添加额外的裁剪开关，保持与上游一致。
    preprocessConfig: {},

    // 图片转存：下载字节 → multipart POST。
    // 百家号图片上传需要真实 multipart 上传，不支持传 URL 让服务端自拉。
    // 跳过已在百家号/百度图床的图。
    image: {
        skip: ['baijiahao.baidu.com', 'bdstatic.com', 'bcebos.com'],
        // uploadFn：在页面内执行，下载图片字节再上传到百家号图床。
        // 移植自 Wechatsync uploadImageByUrl（去掉 this.runtime.fetch → 直接 fetch）。
        uploadFn: async (src, PP) => {
            // 1. 下载图片字节
            const imgResp = await fetch(src, { credentials: 'omit' });
            if (!imgResp.ok) {
                throw new Error('图片下载失败: ' + src + ' HTTP ' + imgResp.status);
            }
            const blob = await imgResp.blob();

            // 2. 构造表单上传
            const fd = new FormData();
            fd.append('media', blob, 'image.jpg');
            fd.append('type', 'image');
            fd.append('app_id', '1589639493090963');
            fd.append('is_waterlog', '1');
            fd.append('save_material', '1');
            fd.append('no_compress', '0');
            fd.append('is_events', '');
            fd.append('article_type', 'news');

            const uploadResp = await fetch('https://baijiahao.baidu.com/pcui/picture/uploadproxy', {
                method: 'POST',
                credentials: 'include',
                body: fd,
            });

            const res = await uploadResp.json();
            if (res.errmsg !== 'success' || !res.ret || !res.ret.https_url) {
                throw new Error(res.errmsg || '图片上传失败');
            }
            return { url: res.ret.https_url };
        },
    },

    /**
     * 页面内发布函数。
     * 移植自 Wechatsync BaijiahaoAdapter.publish()：
     *   1. 从编辑页 HTML 中提取 auth token（window.__BJH__INIT__AUTH__）
     *   2. POST /pcui/article/save（表单，带 token header）
     *   3. 解析 JSONP 响应（bjhdraft(...) 包装）
     * I = { title, content, draftOnly }，content 已完成预处理 + 图片转存。
     */
    publish: async (I, PP) => {
        // 第一步：从编辑页抓取 auth token。
        // 移植自 Wechatsync fetchAuthToken()，runtime.fetch → fetch。
        const editResp = await fetch('https://baijiahao.baidu.com/builder/rc/edit', {
            credentials: 'include',
        });
        const html = await editResp.text();
        const tokenMatch = html.match(/window\.__BJH__INIT__AUTH__\s*=\s*['"]([^'"]+)['"]/);
        if (!tokenMatch) {
            return { ok: false, stage: 'auth', status: editResp.status, message: '登录失效，请重新登录百家号' };
        }
        const authToken = tokenMatch[1];

        // 第二步：保存草稿/发布。
        // 移植自 Wechatsync publish()，runtime.fetch → fetch，HEADER_RULES 删掉（同源天然带）。
        const content = I.content;
        const params = new URLSearchParams({
            title: I.title,
            content: content,
            feed_cat: '1',
            len: String(content.length),
            activity_list: JSON.stringify([{ id: 408, is_checked: 0 }]),
            source_reprinted_allow: '0',
            original_status: '0',
            original_handler_status: '1',
            isBeautify: 'false',
            subtitle: '',
            bjhtopic_id: '',
            bjhtopic_info: '',
            type: 'news',
        });

        const saveResp = await fetch(
            'https://baijiahao.baidu.com/pcui/article/save?callback=bjhdraft',
            {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'token': authToken,
                },
                body: params,
            }
        );

        const text = await saveResp.text();
        // 剥掉 JSONP 包装：bjhdraft({...}) → {...}
        const jsonStr = text.replace(/^bjhdraft\(/, '').replace(/\)$/, '');
        let res = null;
        try { res = JSON.parse(jsonStr); } catch (e) {}

        if (!res || res.errmsg !== 'success' || !res.ret || !res.ret.article_id) {
            return {
                ok: false,
                stage: 'save',
                status: saveResp.status,
                message: (res && res.errmsg) || '保存草稿失败',
            };
        }

        const postId = String(res.ret.article_id);
        const draftUrl = 'https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=' + postId;

        // 注意：Wechatsync 原实现只保存草稿（draftOnly 固定为 true）。
        // 百家号正式发布需要单独的发布审核流程，API 层面只有草稿保存接口可用。
        // 这里无论 draftOnly 是否为 true，均返回草稿链接；draft 字段始终为 true。
        return {
            ok: true,
            id: postId,
            url: draftUrl,
            draft: true,
        };
    },

    // 登录检测（供 whoami.js 复用）。
    // 移植自 Wechatsync checkAuth()：GET /builder/app/appinfo，判断 errmsg === 'success'。
    checkAuth: async (PP) => {
        try {
            const resp = await fetch(
                'https://baijiahao.baidu.com/builder/app/appinfo?_=' + Date.now(),
                { credentials: 'include' }
            );
            const json = await resp.json();
            if (json.errmsg === 'success' && json.data && json.data.user) {
                const u = json.data.user;
                return {
                    isAuthenticated: true,
                    userId: String(u.userid || ''),
                    username: u.name || '',
                    avatar: u.avatar || '',
                };
            }
            return { isAuthenticated: false };
        } catch (e) {
            return { isAuthenticated: false, error: String((e && e.message) || e) };
        }
    },
};

// ── CLI 注册 ────────────────────────────────────────────────────────────────

cli({
    site: 'baijiahao',
    name: 'article',
    access: 'write',
    description: '发布百家号文章（支持保存草稿）。正文默认 Markdown；图片自动转存到百家号图床。',
    domain: 'baijiahao.baidu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown；传 --html 则视为原始 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿（百家号暂只支持草稿模式，此参数保留向后兼容）' },
        { name: 'execute', type: 'boolean', help: '真正执行写操作。不加此参数时命令拒绝写入。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('百家号文章发布需要浏览器会话');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft ?? true); // 百家号目前只支持草稿

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: baijiahaoProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = '已保存百家号文章草稿';
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
