import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';
import { checkLogin } from '../_shared/article/auth.js';

// ── 搜狐号 profile ─────────────────────────────────────────────────────────────
// 搜狐号使用 HTML 格式，图片下载字节后 multipart 上传，需要 accountId。
// accountId 来自登录检测接口，须在 uploadFn 内页面上下文中自行请求，不能依赖闭包。

/**
 * 生成随机 32 位十六进制设备 ID。
 * 写在普通函数体里供 Node 侧 checkLogin 用；页面内也内联了同名版本。
 */
function generateDeviceId() {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < 32; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

export const sohuProfile = {
    home: 'https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1',
    outputFormat: 'html',
    // 搜狐号 preprocessConfig：无特殊要求，保留默认 HTML 即可。
    preprocessConfig: {},

    // 登录检测：调搜狐号子账号列表接口，取第一个子账号信息。
    // 注意：此函数在页面内执行（page.evaluate），不能 import，不能闭包引用文件变量。
    checkAuth: async (PP) => {
        try {
            const resp = await fetch(
                'https://mp.sohu.com/mpbp/bp/account/list?_=' + Date.now(),
                { method: 'GET', credentials: 'include' },
            );
            const res = await resp.json();
            if (res.code !== 2000000 || !res.data?.data?.length) {
                return { isAuthenticated: false };
            }
            const allAccounts = [];
            for (const group of res.data.data) {
                if (group.accounts) allAccounts.push(...group.accounts);
            }
            if (!allAccounts.length) return { isAuthenticated: false };
            const account = allAccounts[0];
            const displayName = allAccounts.length > 1
                ? account.nickName + '（共' + allAccounts.length + '个子账号）'
                : account.nickName;
            return {
                isAuthenticated: true,
                userId: String(account.id),
                username: displayName,
                avatar: account.avatar || '',
            };
        } catch (e) {
            return { isAuthenticated: false, error: String((e && e.message) || e) };
        }
    },

    // 图片转存：搜狐图片上传需要 accountId（从登录接口取），无法用声明式 spec，改用 uploadFn。
    // uploadFn 在页面内执行，内联获取 accountId，再下载字节 multipart 上传。
    image: {
        skip: ['sohu.com'],
        uploadFn: async (src, PP) => {
            // 1. 先取当前登录账号的 accountId
            const authResp = await fetch(
                'https://mp.sohu.com/mpbp/bp/account/list?_=' + Date.now(),
                { method: 'GET', credentials: 'include' },
            );
            const authRes = await authResp.json();
            if (authRes.code !== 2000000 || !authRes.data?.data?.length) {
                throw new Error('获取搜狐账号信息失败，请确认已登录搜狐号');
            }
            const allAccounts = [];
            for (const group of authRes.data.data) {
                if (group.accounts) allAccounts.push(...group.accounts);
            }
            if (!allAccounts.length) throw new Error('搜狐号子账号列表为空');
            const accountId = String(allAccounts[0].id);

            // 2. 下载图片字节
            const imgResp = await fetch(src, { credentials: 'omit' });
            if (!imgResp.ok) throw new Error('图片下载失败（' + imgResp.status + '）：' + src);
            const blob = await imgResp.blob();

            // 3. 上传到搜狐图床
            const fd = new FormData();
            fd.append('file', blob, 'image.jpg');
            fd.append('accountId', accountId);

            const upResp = await fetch(
                'https://mp.sohu.com/commons/front/outerUpload/image/file?accountId=' + accountId,
                { method: 'POST', credentials: 'include', body: fd },
            );
            const upRes = await upResp.json();
            if (!upRes.url) throw new Error('搜狐图片上传失败：' + (upRes.msg || JSON.stringify(upRes).slice(0, 100)));
            return { url: upRes.url };
        },
    },

    // 发布函数：先从账号接口拿 accountId，然后调草稿保存接口。
    // 搜狐号目前只有「保存草稿」接口，没有单独的一键发布 API；draftOnly=false 时同样走草稿，
    // 返回草稿编辑页 URL，让用户自己在管后台点击发布（与 Wechatsync 原始行为一致）。
    // I = { title, content, draftOnly }，content 已完成预处理 + 图片转存。
    publish: async (I, PP) => {
        // 取 accountId
        const authResp = await fetch(
            'https://mp.sohu.com/mpbp/bp/account/list?_=' + Date.now(),
            { method: 'GET', credentials: 'include' },
        );
        const authRes = await authResp.json();
        if (authRes.code !== 2000000 || !authRes.data?.data?.length) {
            return { ok: false, stage: 'auth', status: authResp.status, message: '获取搜狐账号信息失败，请确认已登录搜狐号' };
        }
        const allAccounts = [];
        for (const group of authRes.data.data) {
            if (group.accounts) allAccounts.push(...group.accounts);
        }
        if (!allAccounts.length) {
            return { ok: false, stage: 'auth', status: 0, message: '搜狐号子账号列表为空' };
        }
        const accountId = Number(allAccounts[0].id);

        // 生成设备 ID
        const chars = '0123456789abcdef';
        let dvId = '';
        for (let i = 0; i < 32; i++) dvId += chars[Math.floor(Math.random() * chars.length)];

        const spCm = '100-' + Date.now() + '-' + dvId;

        // 保存草稿（搜狐 v4 API）
        const postData = {
            title: I.title,
            brief: '',
            content: I.content,
            channelId: 24,
            categoryId: -1,
            id: 0,
            userColumnId: 0,
            columnNewsIds: [],
            businessCode: 0,
            declareOriginal: false,
            cover: '',
            topicIds: [],
            isAd: 0,
            userLabels: '[]',
            reprint: false,
            customTags: '',
            infoResource: 0,
            sourceUrl: '',
            visibleToLoginedUsers: 0,
            attrIds: [],
            auto: true,
            accountId: accountId,
        };

        const saveResp = await fetch(
            'https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2?accountId=' + accountId,
            {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'dv-id': dvId,
                    'sp-cm': spCm,
                },
                body: JSON.stringify(postData),
            },
        );
        const saveText = await saveResp.text();
        let saveRes = null;
        try { saveRes = JSON.parse(saveText); } catch (e) {}

        if (!saveResp.ok || !saveRes || !saveRes.success) {
            return {
                ok: false,
                stage: 'draft',
                status: saveResp.status,
                message: (saveRes && saveRes.msg) || saveText.slice(0, 300),
            };
        }

        const postId = String(saveRes.data);
        const draftUrl = 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2&id=' + postId;

        // 搜狐号 API 仅支持保存草稿，无单独发布接口；返回草稿编辑页 URL。
        return { ok: true, id: postId, url: draftUrl, draft: true };
    },
};

// ── 鉴权 profile（供 whoami.js 复用）──────────────────────────────────────────
export const sohuAuthProfile = {
    home: sohuProfile.home,
    checkAuth: sohuProfile.checkAuth,
};

// ── 辅助：requireExecute / resolvePayload / buildResultRow（内联精简版）─────────
function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此命令需要 --execute 才会真正写入，干跑请去掉该参数。');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) throw new CliError('INVALID_INPUT', 'text 和 --file 只能二选一');
    let resolved = text ?? '';
    if (file) {
        const { readFile, stat } = await import('node:fs/promises');
        let s;
        try { s = await stat(file); } catch { throw new CliError('INVALID_INPUT', '文件不存在：' + file); }
        if (!s.isFile()) throw new CliError('INVALID_INPUT', '路径不是可读文本文件：' + file);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', '文件读取失败：' + file); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', '文件不是合法 UTF-8 编码：' + file); }
    }
    if (!resolved.trim()) throw new CliError('INVALID_INPUT', '正文不能为空');
    return resolved;
}

function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

// ── CLI 注册 ───────────────────────────────────────────────────────────────────
cli({
    site: 'sohu',
    name: 'article',
    access: 'write',
    description: '发布文章到搜狐号（HTML 格式，图片自动转存到搜狐图床，保存为草稿）。',
    domain: 'mp.sohu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown，传 --html 则视为 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8，Markdown 或 HTML）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿（搜狐号暂无一键发布 API，此选项默认行为）' },
        { name: 'execute', type: 'boolean', help: '实际执行写入操作；不加此参数则拒绝写入（干跑保护）' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('搜狐号文章发布需要浏览器会话');
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
            profile: sohuProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = result.draft ? '已保存搜狐号草稿' : '已保存搜狐号草稿（搜狐 API 仅支持草稿，请手动发布）';
        if (upN || failN) {
            message += `；图片：${upN} 张已转存${failN ? `，${failN} 张失败` : ''}`;
        }

        return buildResultRow(
            message,
            'article',
            '',
            result.draft ? 'draft' : 'draft',
            { created_target: 'article:' + result.id, created_url: result.url },
        );
    },
});
