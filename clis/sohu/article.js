import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle, gotoWritePage } from '../_shared/article/publish.js';

// ── 搜狐号 profile ─────────────────────────────────────────────────────────────
// 搜狐号使用 HTML 格式，图片下载字节后 multipart 上传，需要 accountId。
// accountId 来自登录检测接口，须在 uploadFn 内页面上下文中自行请求，不能依赖闭包。
//
// 本次新增「正式发布」分支：
//   - draftOnly=true  → 保存草稿（POST /mpbp/bp/news/v4/news/draft/v2，原行为，已真机验证图片转存）。
//   - draftOnly=false → 一键正式发布（POST /mpbp/bp/news/v4/news/publish/v2，id=0 直发）。
// 两个接口共用同一份 baseParams，仅 endpoint 不同。
// 出处（搜狐编辑器 micro-app mp_micro_contentmanager → js/app.9e74a732d8.js，已 re-fetch 核验）：
//   addArticlePushArticle:t=>(0,a.F)("/mpbp/bp/news/v4/news/publish/v2","POST",t,!0,{contentType:"application/json"})
//   baseParams: {title,brief,content,channelId,categoryId,id,userColumnId,columnNewsIds,businessCode,
//     declareOriginal,cover,topicIds,isAd,userLabels,reprint,customTags,infoResource,sourceUrl,visibleToLoginedUsers}
//   发布调用处：const t=this.baseParams();t.attrIds=this.attrs.map(t=>t.id);...addArticlePushArticle(t).then(t=>{2e6==t.code?...})
//   成功判定：2e6==t.code（即 code===2000000）；若 declareOriginal=true 且 data 为对象 → pushOriCheck 原创校验分支。

/**
 * 生成随机 32 位十六进制设备 ID。
 * 写在普通函数体里供 Node 侧用；页面内也内联了同名版本。
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

    // 发布函数：页面内执行（.toString() 注入），只能用页面全局（fetch/document）。
    // I = { title, content, draftOnly, params }，content 已完成预处理 + 图片转存（HTML）。
    // I.params = { channelId, categoryId, cover, brief, topicIds[], userColumnId, attrIds[],
    //   declareOriginal, customTags } —— 由 Node 侧把「名」解析成「id」后注入。
    //   channelId 必填（已解析为合法 id）；categoryId 默认 -1（不限，搜狐合法值，非臆造默认）。
    publish: async (I, PP) => {
        const P = I.params || {};

        // 取 accountId（页面内无法从 Node 侧传入，须自行请求）
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

        // 生成设备 ID + sp-cm 头（与草稿请求一致；出处：现有 adapter + Wechatsync HEADER_RULES）
        const chars = '0123456789abcdef';
        let dvId = '';
        for (let i = 0; i < 32; i++) dvId += chars[Math.floor(Math.random() * chars.length)];
        const spCm = '100-' + Date.now() + '-' + dvId;

        // ── baseParams：草稿与发布共用同一份（字段顺序/取值与搜狐 bundle baseParams 对齐）─
        // channelId 必填且已是合法 id；categoryId 缺省 -1（搜狐「不限」语义）。
        const channelId = Number(P.channelId);
        if (!Number.isFinite(channelId) || channelId <= 0) {
            return { ok: false, stage: 'params', status: 0, message: '缺少合法 channelId（频道 id），请先用 `sohu channels` 取值' };
        }
        const categoryId = (P.categoryId == null || P.categoryId === '') ? -1 : Number(P.categoryId);

        const postData = {
            title: I.title,
            brief: typeof P.brief === 'string' ? P.brief : '',
            content: I.content,
            channelId: channelId,
            categoryId: categoryId,
            id: 0,
            userColumnId: (P.userColumnId == null || -1 == P.userColumnId) ? 0 : Number(P.userColumnId),
            columnNewsIds: Array.isArray(P.columnNewsIds) ? P.columnNewsIds : [],
            businessCode: 0,
            declareOriginal: Boolean(P.declareOriginal),
            cover: typeof P.cover === 'string' ? P.cover : '',
            topicIds: Array.isArray(P.topicIds) ? P.topicIds : [],
            isAd: 0,
            userLabels: '[]',
            reprint: false,
            customTags: typeof P.customTags === 'string' ? P.customTags : '',
            infoResource: 0,
            sourceUrl: '',
            visibleToLoginedUsers: 0,
            attrIds: Array.isArray(P.attrIds) ? P.attrIds : [],
            accountId: accountId,
        };

        // ── 草稿分支：POST draft/v2（原行为，含 auto:true）──────────────────────
        if (I.draftOnly) {
            const draftBody = Object.assign({}, postData, { auto: true });
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
                    body: JSON.stringify(draftBody),
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

            const draftId = String(saveRes.data);
            const draftUrl = 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=2&id=' + draftId;
            return { ok: true, id: draftId, url: draftUrl, draft: true };
        }

        // ── 正式发布分支：POST publish/v2（id=0 直发）────────────────────────────
        const pubResp = await fetch(
            'https://mp.sohu.com/mpbp/bp/news/v4/news/publish/v2?accountId=' + accountId,
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
        const pubText = await pubResp.text();
        let pubRes = null;
        try { pubRes = JSON.parse(pubText); } catch (e) {}

        // 成功判定：code===2000000（bundle `2e6==t.code`）。
        if (!pubResp.ok || !pubRes || pubRes.code !== 2000000) {
            return {
                ok: false,
                stage: 'publish',
                status: pubResp.status,
                message: (pubRes && (pubRes.msg || pubRes.message)) || pubText.slice(0, 300),
            };
        }

        // 声明原创时，data 可能是对象（pushOriCheck 原创校验拦截），此时并非「已发布成功」。
        if (pubRes.data != null && Object.prototype.toString.call(pubRes.data) === '[object Object]') {
            return {
                ok: false,
                stage: 'origin_check',
                status: pubResp.status,
                message: '声明原创触发了原创校验（需在搜狐后台完成原创确认）：' + JSON.stringify(pubRes.data).slice(0, 200),
            };
        }

        const newsId = String(pubRes.data);
        const newsUrl = 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?spm=smmp.articlelist.0.0&contentStatus=1&id=' + newsId;
        return { ok: true, id: newsId, url: newsUrl, draft: false };
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

// ── 名→id 解析（在 Node 侧调搜狐列举接口，精确匹配，找不到报错，禁止 fallback）──────
// 这些列举接口都需登录态 cookie，所以在浏览器页面内执行（page.evaluate）。
// 解析失败一律抛 CliError(INVALID_INPUT)，不静默返回默认值。

/**
 * 在页面内调搜狐列举接口取一个 JSON 数组（带统一错误信息）。
 * @returns {Promise<any>} 接口原始 JSON
 */
async function fetchSohuJson(page, urlExpr, label) {
    const js =
        '(async () => {' +
        'try {' +
        'const r = await fetch(' + JSON.stringify(urlExpr) + ', { method: "GET", credentials: "include" });' +
        'const t = await r.text();' +
        'let j = null; try { j = JSON.parse(t); } catch (e) {}' +
        'return { ok: r.ok, status: r.status, json: j, text: t.slice(0, 300) };' +
        '} catch (e) { return { ok: false, status: 0, json: null, text: String((e && e.message) || e) }; }' +
        '})()';
    const res = await page.evaluate(js);
    if (!res || !res.ok || !res.json) {
        throw new CliError('INVALID_INPUT', '搜狐' + label + '接口请求失败（HTTP ' + (res ? res.status : '?') + '）：' + (res ? res.text : ''));
    }
    if (res.json.success === false || (res.json.code != null && res.json.code !== 2000000 && res.json.code !== 2000)) {
        throw new CliError('INVALID_INPUT', '搜狐' + label + '接口返回错误：' + (res.json.msg || res.json.message || '未登录或无权限'));
    }
    return res.json;
}

/** 取当前 accountId（很多接口要它）。 */
async function resolveAccountId(page) {
    const j = await fetchSohuJson(
        page,
        'https://mp.sohu.com/mpbp/bp/account/list?_=' + Date.now(),
        '账号列表',
    );
    const groups = (j.data && j.data.data) || [];
    const accounts = [];
    for (const g of groups) { if (g.accounts) accounts.push(...g.accounts); }
    if (!accounts.length) throw new CliError('INVALID_INPUT', '搜狐号子账号列表为空，请确认已登录搜狐号');
    return String(accounts[0].id);
}

/** 从频道列举里把频道名解析成 channelId（精确匹配）。 */
async function resolveChannelId(page, channelName) {
    const j = await fetchSohuJson(
        page,
        'https://mp.sohu.com/mpbp/bp/account/common/channels-data-api?status=1',
        '频道列举',
    );
    const list = j.data || [];
    const hit = list.find((c) => String(c.name) === String(channelName));
    if (!hit) {
        throw new CliError('INVALID_INPUT', '未找到频道「' + channelName + '」，可选：' + (list.map((c) => c.name).join(' / ') || '（空）') + '。用 `sohu channels` 查看完整列表。');
    }
    return Number(hit.id != null ? hit.id : hit.channelId);
}

/** 在指定频道下把分类名解析成 categoryId（精确匹配）。 */
async function resolveCategoryId(page, channelId, categoryName) {
    const j = await fetchSohuJson(
        page,
        'https://mp.sohu.com/mpbp/bp/account/common/channels/' + channelId + '/categories',
        '分类列举',
    );
    const list = j.data || [];
    const hit = list.find((c) => String(c.name) === String(categoryName));
    if (!hit) {
        throw new CliError('INVALID_INPUT', '频道（id=' + channelId + '）下未找到分类「' + categoryName + '」，可选：' + (list.map((c) => c.name).join(' / ') || '（该频道无分类）') + '。用 `sohu categories --channel <频道名>` 查看。');
    }
    return Number(hit.id);
}

/** 把专栏名解析成 userColumnId（精确匹配）。 */
async function resolveColumnId(page, columnName) {
    const j = await fetchSohuJson(
        page,
        'https://mp.sohu.com/mpbp/bp/account/column/v2/list',
        '专栏列举',
    );
    const list = (j.data && (j.data.data || j.data)) || j.data || [];
    const arr = Array.isArray(list) ? list : [];
    const hit = arr.find((c) => String(c.name) === String(columnName));
    if (!hit) {
        throw new CliError('INVALID_INPUT', '未找到专栏「' + columnName + '」，可选：' + (arr.map((c) => c.name).join(' / ') || '（你还没有任何专栏）') + '。用 `sohu columns` 查看。');
    }
    return Number(hit.id);
}

/** 把话题名（逗号分隔）解析成 topicIds 数组（每个精确匹配）。 */
async function resolveTopicIds(page, accountId, topicNames) {
    const names = topicNames.split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return [];
    const ids = [];
    for (const name of names) {
        const j = await fetchSohuJson(
            page,
            'https://mp.sohu.com/mpbp/bp/news/v4/label/topic/search?accountId=' + accountId + '&keyword=' + encodeURIComponent(name),
            '话题搜索',
        );
        const list = (j.data) || [];
        const hit = list.find((t) => String(t.name) === String(name));
        if (!hit) {
            throw new CliError('INVALID_INPUT', '未找到话题「' + name + '」，请用 `sohu topics --keyword ' + name + '` 搜索确认确切名称。');
        }
        ids.push(hit.id);
    }
    return ids;
}

// ── CLI 注册 ───────────────────────────────────────────────────────────────────
cli({
    site: 'sohu',
    name: 'article',
    access: 'write',
    description: '发布文章到搜狐号（HTML 格式，外链图片自动转存到搜狐图床）。默认正式发布，加 --draft 仅存草稿。频道必填，合法值用 `sohu channels` 取。',
    domain: 'mp.sohu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown，传 --html 则视为 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8，Markdown 或 HTML）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'channel', help: '频道名（精确匹配，必填），合法值用 `sohu channels` 列举' },
        { name: 'category', help: '分类名（精确匹配，依赖所选频道），合法值用 `sohu categories --channel <频道名>` 列举；不传=不限' },
        { name: 'column', help: '专栏名（精确匹配），合法值用 `sohu columns` 列举；不传=不归属专栏' },
        { name: 'topics', help: '话题名，逗号分隔（每个精确匹配），用 `sohu topics` 搜索取确切名' },
        { name: 'cover', help: '封面图 URL（须为搜狐图床地址）；可空' },
        { name: 'brief', help: '文章摘要；可空' },
        { name: 'declare-original', type: 'boolean', help: '声明原创（会触发搜狐原创校验，发布将被拦到原创确认流程）' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿，不正式发布' },
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

        // ── 解析发布参数（名→id，全部精确匹配，禁止 fallback）──────────────────
        // 频道：草稿与发布都必填（搜狐 baseParams 总带 channelId）。先解析，失败即抛 typed error。
        const channelName = typeof kwargs.channel === 'string' ? kwargs.channel.trim() : '';
        if (!channelName) {
            throw new CliError('INVALID_INPUT', '缺少 --channel（频道名）。请先运行 `sohu channels` 取合法频道名再传入，不提供默认值。');
        }
        // 名→id 解析需要浏览器会话（列举接口靠登录态 cookie），先导航到已登录写作页。
        await gotoWritePage(page, sohuProfile.home);

        const channelId = await resolveChannelId(page, channelName);

        let categoryId = -1; // 搜狐合法「不限」值，非臆造默认
        const categoryName = typeof kwargs.category === 'string' ? kwargs.category.trim() : '';
        if (categoryName) {
            categoryId = await resolveCategoryId(page, channelId, categoryName);
        }

        let userColumnId = 0;
        const columnName = typeof kwargs.column === 'string' ? kwargs.column.trim() : '';
        if (columnName) {
            userColumnId = await resolveColumnId(page, columnName);
        }

        let topicIds = [];
        const topicsRaw = typeof kwargs.topics === 'string' ? kwargs.topics.trim() : '';
        if (topicsRaw) {
            const accountId = await resolveAccountId(page);
            topicIds = await resolveTopicIds(page, accountId, topicsRaw);
        }

        const publishParams = {
            channelId,
            categoryId,
            userColumnId,
            topicIds,
            cover: typeof kwargs.cover === 'string' ? kwargs.cover.trim() : '',
            brief: typeof kwargs.brief === 'string' ? kwargs.brief : '',
            declareOriginal: Boolean(kwargs['declare-original']),
        };

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: sohuProfile,
            publishParams,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = result.draft ? '已保存搜狐号草稿' : '已正式发布到搜狐号';
        if (upN || failN) {
            message += `；图片：${upN} 张已转存${failN ? `，${failN} 张失败` : ''}`;
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

export const __test__ = { sohuProfile, requireExecute, buildResultRow, resolvePayload, generateDeviceId };
