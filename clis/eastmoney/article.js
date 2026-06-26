import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';
import { checkLogin } from '../_shared/article/auth.js';

// ── 登录态检测 profile（供 whoami.js 导入复用）────────────────────────────
export const authProfile = {
    home: 'https://mp.eastmoney.com',
    /**
     * 页面内执行：从 cookie 读 ct/ut，再调账号信息接口。
     * 东方财富不走全局 state，直接打 API 检测。
     */
    checkAuth: async (PP) => {
        const ctoken = PP.cookie('ct');
        const utoken = PP.cookie('ut');
        if (!ctoken || !utoken) {
            return { isAuthenticated: false, error: '未检测到登录 cookie（ct/ut），请先登录东方财富' };
        }
        try {
            const resp = await fetch(
                `https://caifuhaoapi.eastmoney.com/api/v2/getauthorinfo?platform=&ctoken=${encodeURIComponent(ctoken)}&utoken=${encodeURIComponent(utoken)}`,
                { method: 'GET', credentials: 'include', headers: { 'x-requested-with': 'fetch' } },
            );
            if (!resp.ok) {
                return { isAuthenticated: false, error: `账号接口 HTTP ${resp.status}` };
            }
            const data = await resp.json();
            if (data.Success === 1 && data.Result && data.Result.accountId) {
                return {
                    isAuthenticated: true,
                    userId: String(data.Result.accountId),
                    username: data.Result.accountName || '',
                    avatar: data.Result.portrait || '',
                };
            }
            return { isAuthenticated: false };
        } catch (e) {
            return { isAuthenticated: false, error: String((e && e.message) || e) };
        }
    },
};

// ── 东方财富文章发布 profile ─────────────────────────────────────────────
// 移植自 Wechatsync EastmoneyAdapter，模型差异：
//   · runtime.fetch → 页面内 fetch（同源带 cookie，Origin 天然正确）
//   · HEADER_RULES / withHeaderRules 全部删除（opencli 走页面内 evaluate 无需）
//   · runtime.getCookie → PP.cookie（页面内读 document.cookie）
//   · runtime.storage（deviceId 持久化）→ 页面内每次重新生成（发布低频，无需持久化）
//   · 图片两条路径（远程 URL 传链接 / data URI 传字节）→ uploadFn 实现
const eastmoneyProfile = {
    home: 'https://mp.eastmoney.com',
    outputFormat: 'html',
    // 预处理开关，原样移植自 Wechatsync EastmoneyAdapter.preprocessConfig
    preprocessConfig: {
        removeComments: true,
        removeSpecialTags: true,
        processCodeBlocks: true,
        convertSectionToDiv: true,
        removeEmptyLines: true,
        removeEmptyDivs: true,
        removeNestedEmptyContainers: true,
        unwrapSingleChildContainers: true,
        unwrapNestedFigures: true,
        removeTrailingBr: true,
        removeDataAttributes: true,
        removeSrcset: true,
        removeSizes: true,
        compactHtml: true,
    },
    // 图片转存：两条路径，用 uploadFn 实现（声明式 spec 装不下）
    //   · 远程 URL → PUT /iimage/image/byLink（传 ctoken/utoken + linkUrl）
    //   · data URI → POST /iimage/image（multipart，Blob）
    image: {
        skip: ['gbres.dfcfw.com'],
        uploadFn: async (src, PP) => {
            const ctoken = PP.cookie('ct');
            const utoken = PP.cookie('ut');
            if (!ctoken || !utoken) {
                throw new Error('东方财富图片上传失败：未检测到登录 cookie（ct/ut），请先登录');
            }

            // data URI → 二进制上传
            if (src.indexOf('data:') === 0) {
                const parts = src.split(',');
                const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png';
                const ext = mime.split('/')[1] || 'png';
                const binStr = atob(parts[1]);
                const bytes = new Uint8Array(binStr.length);
                for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
                const blob = new Blob([bytes], { type: mime });
                const filename = Date.now() + '.' + ext;

                const fd = new FormData();
                fd.append('file', blob, filename);
                fd.append('noinlist', '1');
                fd.append('utoken', utoken);
                fd.append('ctoken', ctoken);

                const resp = await fetch('https://gbapi.eastmoney.com/iimage/image?platform=', {
                    method: 'POST',
                    credentials: 'include',
                    body: fd,
                });
                const res = await resp.json();
                if (res.code === 200 && res.data && res.data.url) {
                    return { url: res.data.url };
                }
                throw new Error('东方财富图片二进制上传失败：' + (res.message || '未知错误') + ' (code: ' + res.code + ')');
            }

            // 远程 URL → 链接上传
            const body = new URLSearchParams({
                noinlist: '1',
                linkUrl: src,
                ctoken: ctoken,
                utoken: utoken,
            });
            const resp = await fetch('https://gbapi.eastmoney.com/iimage/image/byLink?platform=', {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
            });
            const res = await resp.json();
            if (res.code === 200 && res.data && res.data.url) {
                return { url: res.data.url };
            }
            throw new Error('东方财富图片链接上传失败：' + (res.message || '未知错误') + ' (code: ' + res.code + ')');
        },
    },
    /**
     * 页面内发布函数，移植自 Wechatsync EastmoneyAdapter.publish。
     * 流程：读 cookie token → 生成 deviceId → 建空草稿 → 更新草稿内容（只存草稿）。
     * 东方财富 mp 端目前仅支持草稿保存，不支持一键发布，draftOnly 强制为 true。
     */
    publish: async (I, PP) => {
        const ctoken = PP.cookie('ct');
        const utoken = PP.cookie('ut');
        if (!ctoken || !utoken) {
            return { ok: false, stage: 'auth', status: 401, message: '未检测到登录 cookie（ct/ut），请先登录东方财富' };
        }

        // 生成一个随机 deviceId（32 位大写 hex）
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        const deviceid = Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0').toUpperCase(); }).join('');

        // 构造 API 参数数组（移植自 Wechatsync buildParm）
        function buildParm(params) {
            return [
                { ip: '$IP$' },
                { deviceid: deviceid },
                { version: '100' },
                { plat: 'web' },
                { product: 'CFH' },
                { ctoken: ctoken },
                { utoken: utoken },
                { draftid: params.draftid || '' },
                { drafttype: '0' },
                { type: '0' },
                { title: encodeURIComponent(params.title) },
                { text: encodeURIComponent(params.text) },
                { columns: '2' },
                { cover: '' },
                { issimplevideo: '0' },
                { videos: '' },
                { vods: '' },
                { isoriginal: '0' },
                { tgProduct: '' },
                { spcolumns: '' },
                { textsource: '0' },
                { replyauthority: '' },
                { modules: encodeURIComponent('[]') },
            ];
        }

        // 调用草稿 API（移植自 Wechatsync callDraftApi）
        async function callDraftApi(parm, draftId) {
            const pageUrl = draftId
                ? 'https://mp.eastmoney.com/collect/pc_article/index.html#/?id=' + draftId
                : 'https://mp.eastmoney.com/collect/pc_article/index.html#/';

            const body = JSON.stringify({
                pageUrl: pageUrl,
                path: 'draft/api/Article/SaveDraft',
                parm: JSON.stringify(parm),
            });

            const resp = await fetch('https://emfront.eastmoney.com/apifront/Tran/GetData?platform=', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: body,
            });

            if (!resp.ok) {
                return { ok: false, stage: 'draft_api', status: resp.status, message: '草稿 API 请求失败: ' + resp.status };
            }

            let rawData;
            try {
                rawData = await resp.json();
            } catch (e) {
                return { ok: false, stage: 'draft_api', status: resp.status, message: '草稿 API 响应不是有效 JSON' };
            }

            if (!rawData.RRquestSuccess || rawData.RCode !== 200) {
                return { ok: false, stage: 'draft_api', status: rawData.RCode, message: '草稿 API 错误: ' + (rawData.RMsg || '未知错误') };
            }

            let innerData;
            try {
                innerData = JSON.parse(rawData.RData);
            } catch (e) {
                return { ok: false, stage: 'draft_parse', status: 200, message: '无法解析草稿响应数据' };
            }

            if (innerData.error_code !== 0) {
                return { ok: false, stage: 'draft_business', status: innerData.error_code, message: '草稿业务错误: ' + (innerData.me || '未知错误') };
            }

            return { ok: true, data: innerData };
        }

        // 第一步：建空草稿，获取 draft_id
        const createParm = buildParm({
            title: I.title,
            text: '<div class="xeditor_content cfh_web"></div>',
        });
        const createResult = await callDraftApi(createParm);
        if (!createResult.ok) return createResult;

        const draftId = createResult.data && createResult.data.draft_id;
        if (!draftId) {
            return { ok: false, stage: 'create', status: 200, message: '创建草稿失败：响应缺少 draft_id' };
        }

        // 第二步：更新草稿内容
        const updateParm = buildParm({
            draftid: draftId,
            title: I.title,
            text: '<div class="xeditor_content cfh_web">' + I.content + '</div>',
        });
        const updateResult = await callDraftApi(updateParm, draftId);
        if (!updateResult.ok) return updateResult;

        // 东方财富 mp 端只支持草稿，不支持直接发布
        const draftUrl = 'https://mp.eastmoney.com/collect/pc_article/index.html#/?id=' + draftId;
        return { ok: true, draft: true, id: draftId, url: draftUrl };
    },
};

// ── 辅助函数：requireExecute / resolvePayload / buildResultRow ────────────
// 东方财富暂无独立的 write-shared.js，此处内联精简实现（参考 zhihu/write-shared.js）

import { readFile, stat } from 'node:fs/promises';

function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此命令需要 --execute 参数才能实际写入，干运行请去掉 --execute 检查参数');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '正文和 --file 只能二选一');
    }
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', `文件不存在：${file}`); }
        if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', `必须是可读文本文件：${file}`);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', `文件无法读取：${file}`); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch {
            throw new CliError('INVALID_INPUT', `文件无法以 UTF-8 解码：${file}`);
        }
    }
    if (!resolved.trim()) throw new CliError('INVALID_INPUT', '正文不能为空');
    return resolved;
}

function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

// ── CLI 注册 ─────────────────────────────────────────────────────────────
cli({
    site: 'eastmoney',
    name: 'article',
    access: 'write',
    description: '发布东方财富财富号文章（草稿）。正文默认 Markdown；图片自动转存到东方财富图床。',
    domain: 'mp.eastmoney.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown；--html 表示 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '正文格式为 HTML 而非 Markdown' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿（东方财富 mp 端目前仅支持草稿，默认即草稿）' },
        { name: 'execute', type: 'boolean', help: '确认实际写入，不带此参数时拒绝写操作' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('东方财富文章发布需要浏览器会话（browser session required）');
        requireExecute(kwargs);

        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');

        const body = await resolvePayload(kwargs);
        // 东方财富只吃草稿，draftOnly 固定为 true（profile.publish 也强制返回 draft:true）
        const draftOnly = true;

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: eastmoneyProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = '已保存东方财富草稿';
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
