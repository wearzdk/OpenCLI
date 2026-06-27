import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';

// ── 掘金发布 profile ────────────────────────────────────────────────────────
// 掘金吃 Markdown（outputFormat:'markdown'），无需预处理（DOM 操作对 markdown 无意义）。
// 图片走字节 ImageX 多步上传（gen_token → ApplyImageUpload + AWS4 → PUT TOS + CRC32
// → CommitImageUpload → get_img_url），流程复杂，使用 uploadFn 在页面内完成。
// CSRF：HEAD api.juejin.cn/user_api/v1/sys/token 取 x-ware-csrf-token，
//   格式 "0,<实际token>,86370000,success,<session>" — 取 parts[1]。

export const juejinProfile = {
    home: 'https://juejin.cn',
    outputFormat: 'markdown',

    // ── 登录检测（whoami 复用）──────────────────────────────────────────────
    // 移植自 Wechatsync JuejinAdapter.checkAuth()
    checkAuth: async (PP) => {
        try {
            const resp = await fetch('https://api.juejin.cn/user_api/v1/user/get', {
                method: 'GET',
                credentials: 'include',
            });
            const data = await resp.json();
            if (data && data.data && data.data.user_id) {
                return {
                    isAuthenticated: true,
                    userId: data.data.user_id,
                    username: data.data.user_name || '',
                    avatar: data.data.avatar_large || '',
                };
            }
            return { isAuthenticated: false };
        } catch (e) {
            return { isAuthenticated: false, error: String((e && e.message) || e) };
        }
    },

    // ── 图片转存：ImageX 多步上传（页面内自定义函数）─────────────────────────
    // 移植自 Wechatsync JuejinAdapter.uploadImageBinaryInternal
    // uploadFn 接收图片 src（URL 或 data:），返回 { url: 掘金图床地址 }。
    // 全部使用页面内全局（fetch / crypto.subtle），不依赖 Node API。
    image: {
        skip: ['juejin.cn', 'p1-juejin', 'p3-juejin', 'p6-juejin', 'p9-juejin', 'byteimg.com'],
        uploadFn: async (src, PP) => {
            // ── 工具函数（页面内，不能 import）──────────────────────────────

            // HMAC-SHA256，返回 ArrayBuffer
            async function hmacSha256(key, message) {
                const keyBytes = key instanceof Uint8Array ? key : new Uint8Array(key);
                const cryptoKey = await crypto.subtle.importKey(
                    'raw', keyBytes.buffer,
                    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
                );
                return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
            }

            // SHA256 → hex
            async function sha256hex(message) {
                const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
                return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
            }

            // ArrayBuffer → hex
            function bufToHex(buf) {
                return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
            }

            // AWS4 签名（仅需 header 签名，不需要 query 签名）
            async function signAWS4(method, url, accessKeyId, secretAccessKey, securityToken) {
                const parsedUrl = new URL(url);
                const path = parsedUrl.pathname;
                // 规范化查询字符串（按参数名排序）
                const sortedParams = Array.from(parsedUrl.searchParams.entries())
                    .sort((a, b) => a[0].localeCompare(b[0]));
                const canonicalQueryString = sortedParams
                    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
                    .join('&');

                const now = new Date();
                const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
                const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');

                // 构建签名 headers
                const signedHeadersObj = { 'x-amz-date': amzDate };
                if (securityToken) signedHeadersObj['x-amz-security-token'] = securityToken;

                const signedHeaderNames = Object.keys(signedHeadersObj)
                    .map(k => k.toLowerCase()).sort().join(';');
                const canonicalHeaders = Object.entries(signedHeadersObj)
                    .map(([k, v]) => k.toLowerCase() + ':' + v.trim())
                    .sort().join('\n') + '\n';

                const payloadHash = await sha256hex('');

                const canonicalRequest = [
                    method.toUpperCase(), path || '/',
                    canonicalQueryString, canonicalHeaders,
                    signedHeaderNames, payloadHash,
                ].join('\n');

                const region = 'cn-north-1';
                const service = 'imagex';
                const algorithm = 'AWS4-HMAC-SHA256';
                const credentialScope = dateStamp + '/' + region + '/' + service + '/aws4_request';
                const canonicalRequestHash = await sha256hex(canonicalRequest);
                const stringToSign = [algorithm, amzDate, credentialScope, canonicalRequestHash].join('\n');

                const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + secretAccessKey), dateStamp);
                const kRegion = await hmacSha256(kDate, region);
                const kService = await hmacSha256(kRegion, service);
                const kSigning = await hmacSha256(kService, 'aws4_request');
                const signature = bufToHex(await hmacSha256(kSigning, stringToSign));

                const authorization = algorithm + ' Credential=' + accessKeyId + '/' + credentialScope
                    + ', SignedHeaders=' + signedHeaderNames + ', Signature=' + signature;

                const resultHeaders = { authorization, 'x-amz-date': amzDate };
                if (securityToken) resultHeaders['x-amz-security-token'] = securityToken;
                return resultHeaders;
            }

            // CRC32（移植自 Wechatsync lib/aws4.ts）
            function crc32(data) {
                let crc = 0xFFFFFFFF;
                const table = new Uint32Array(256);
                for (let i = 0; i < 256; i++) {
                    let c = i;
                    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                    table[i] = c;
                }
                for (let i = 0; i < data.length; i++) {
                    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
                }
                return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
            }

            // ── 常量（写死进函数体，不能闭包引用外部变量）────────────────────
            const IMAGEX_AID = '2608';
            const IMAGEX_SERVICE_ID = '73owjymdk6';
            const uuid = Date.now().toString(16) + Math.random().toString(16).slice(2);

            // ── 第一步：下载图片字节 ─────────────────────────────────────────
            let blob;
            if (src.indexOf('data:') === 0) {
                blob = await fetch(src).then(function (r) { return r.blob(); });
            } else {
                const dlResp = await fetch(src, { method: 'GET' });
                if (!dlResp.ok) throw new Error('下载图片失败: ' + dlResp.status);
                blob = await dlResp.blob();
            }

            // ── 第二步：获取 ImageX 上传凭证（gen_token）────────────────────
            const genTokenUrl = 'https://api.juejin.cn/imagex/v2/gen_token?aid=' + IMAGEX_AID
                + '&uuid=' + uuid + '&client=web';
            const tokenResp = await fetch(genTokenUrl, {
                method: 'GET',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
            });
            const tokenData = await tokenResp.json();
            if (tokenData.err_no && tokenData.err_no !== 0) {
                throw new Error('获取 ImageX 凭证失败: ' + (tokenData.err_msg || tokenData.err_no));
            }
            const tok = tokenData.data && tokenData.data.token;
            if (!tok || !tok.AccessKeyId || !tok.SecretAccessKey) {
                throw new Error('ImageX 凭证响应无效');
            }
            const accessKeyId = tok.AccessKeyId;
            const secretAccessKey = tok.SecretAccessKey;
            const sessionToken = tok.SessionToken;

            // ── 第三步：申请上传地址（ApplyImageUpload，AWS4 签名）──────────
            const applyUrl = 'https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=' + IMAGEX_SERVICE_ID;
            const applyHeaders = await signAWS4('GET', applyUrl, accessKeyId, secretAccessKey, sessionToken);
            const applyResp = await fetch(applyUrl, { method: 'GET', headers: applyHeaders });
            const applyData = await applyResp.json();
            const uploadAddress = applyData && applyData.Result && applyData.Result.UploadAddress;
            if (!uploadAddress) throw new Error('申请上传地址失败');
            const storeInfo = uploadAddress.StoreInfos && uploadAddress.StoreInfos[0];
            const uploadHost = uploadAddress.UploadHosts && uploadAddress.UploadHosts[0];
            if (!storeInfo || !uploadHost) throw new Error('上传地址无效');
            const sessionKey = uploadAddress.SessionKey;

            // ── 第四步：PUT 文件到 TOS（带 CRC32）───────────────────────────
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            const crc32Value = crc32(uint8Array);
            const tosUrl = 'https://' + uploadHost + '/' + storeInfo.StoreUri;
            const tosResp = await fetch(tosUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': storeInfo.Auth,
                    'Content-Type': blob.type || 'application/octet-stream',
                    'Content-CRC32': crc32Value,
                },
                body: blob,
            });
            if (!tosResp.ok) {
                const tosText = await tosResp.text();
                throw new Error('TOS 上传失败: ' + tosResp.status + ' ' + tosText.slice(0, 100));
            }

            // ── 第五步：CommitImageUpload（AWS4 签名 POST）───────────────────
            const commitUrl = 'https://imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01&SessionKey='
                + encodeURIComponent(sessionKey) + '&ServiceId=' + IMAGEX_SERVICE_ID;
            const commitHeaders = await signAWS4('POST', commitUrl, accessKeyId, secretAccessKey, sessionToken);
            commitHeaders['Content-Length'] = '0';
            const commitResp = await fetch(commitUrl, { method: 'POST', headers: commitHeaders });
            const commitData = await commitResp.json();
            if (!commitData.Result) throw new Error('提交图片上传失败');

            // ── 第六步：获取图片 URL（get_img_url）──────────────────────────
            const storeUri = storeInfo.StoreUri;
            const imgUrlResp = await fetch(
                'https://api.juejin.cn/imagex/v2/get_img_url?aid=' + IMAGEX_AID
                + '&uuid=' + uuid + '&uri=' + encodeURIComponent(storeUri) + '&img_type=private',
                { method: 'GET', credentials: 'include', headers: { 'Content-Type': 'application/json' } }
            );
            const imgUrlData = await imgUrlResp.json();
            if (imgUrlData.err_no && imgUrlData.err_no !== 0) {
                throw new Error('获取图片 URL 失败: ' + (imgUrlData.err_msg || imgUrlData.err_no));
            }
            const imageUrl = imgUrlData.data && (imgUrlData.data.main_url || imgUrlData.data.backup_url);
            if (!imageUrl) throw new Error('图片 URL 响应无效');

            return { url: imageUrl };
        },
    },

    // ── 页面内发布函数 ──────────────────────────────────────────────────────
    // 移植自 Wechatsync JuejinAdapter.publish()，并扩展正式发布能力。
    // I = { title, content, draftOnly, params }；content 已完成图片转存（markdown）。
    // I.params = { category, tags:[...], brief }（发布所需参数，draftOnly 时可空）。
    // 发布流程：创建草稿（API）→ 发布草稿（API content_api/v1/article/publish）。
    // 分类/标签按「名称精确匹配」解析为 ID，找不到即报错——**绝不 fallback 默认值**。
    publish: async (I, PP) => {
        const p = I.params || {};

        // ── 获取 CSRF token ────────────────────────────────────────────────
        // HEAD api.juejin.cn/user_api/v1/sys/token，取响应头 x-ware-csrf-token
        // 格式："0,<实际token>,86370000,success,<session_id>"，取 parts[1]
        let csrfToken = '';
        try {
            const tokenResp = await fetch('https://api.juejin.cn/user_api/v1/sys/token', {
                method: 'HEAD',
                credentials: 'include',
                headers: {
                    'x-secsdk-csrf-request': '1',
                    'x-secsdk-csrf-version': '1.2.10',
                },
            });
            const wareToken = tokenResp.headers.get('x-ware-csrf-token');
            if (wareToken) {
                const parts = wareToken.split(',');
                if (parts.length >= 2) csrfToken = parts[1];
            }
        } catch (e) {
            // CSRF 获取失败时继续尝试（部分环境可能无此头）
        }

        const jsonHeaders = { 'Content-Type': 'application/json' };
        if (csrfToken) jsonHeaders['x-secsdk-csrf-token'] = csrfToken;

        // ── 解析分类名 → category_id（精确匹配，找不到报错，不 fallback）──────
        let categoryId = '0';
        if (p.category) {
            let catList = [];
            try {
                const cr = await fetch('https://api.juejin.cn/tag_api/v1/query_category_briefs', { method: 'GET', credentials: 'include' });
                const cd = await cr.json();
                catList = (cd && cd.data) || [];
            } catch (e) {
                return { ok: false, stage: 'category', message: '获取掘金分类列表失败：' + String((e && e.message) || e) };
            }
            const hit = catList.find((c) => c.category_name === p.category);
            if (!hit) {
                return { ok: false, stage: 'category', message: '未找到分类「' + p.category + '」，可选：' + catList.map((c) => c.category_name).join(' / ') };
            }
            categoryId = String(hit.category_id);
        }

        // ── 解析标签名 → tag_ids（逐个精确匹配，找不到报错，不 fallback）─────
        const tagIds = [];
        if (p.tags && p.tags.length) {
            for (const name of p.tags) {
                let tagList = [];
                try {
                    const tr = await fetch('https://api.juejin.cn/tag_api/v1/query_tag_list', {
                        method: 'POST', credentials: 'include', headers: jsonHeaders,
                        body: JSON.stringify({ cursor: '0', key_word: name, limit: 20, sort_type: 1 }),
                    });
                    const td = await tr.json();
                    tagList = ((td && td.data) || []).map((t) => (t && t.tag) ? t.tag : t);
                } catch (e) {
                    return { ok: false, stage: 'tag', message: '搜索标签「' + name + '」失败：' + String((e && e.message) || e) };
                }
                const hit = tagList.find((t) => String(t.tag_name || '').toLowerCase() === String(name).toLowerCase());
                if (!hit) {
                    const avail = tagList.slice(0, 8).map((t) => t.tag_name).filter(Boolean).join(' / ');
                    return { ok: false, stage: 'tag', message: '未找到标签「' + name + '」（精确名匹配）' + (avail ? '；相近：' + avail : '') };
                }
                tagIds.push(String(hit.tag_id));
            }
        }

        // ── 发布必填校验（绝不 fallback 默认值）─────────────────────────────
        if (!I.draftOnly) {
            if (categoryId === '0') {
                return { ok: false, stage: 'validate', message: '发布掘金文章必须指定分类：--category <后端|前端|Android|iOS|人工智能|开发工具|代码人生|阅读>' };
            }
            if (!tagIds.length) {
                return { ok: false, stage: 'validate', message: '发布掘金文章必须指定标签：--tags <标签名,标签名>（至少一个，按名精确匹配）' };
            }
            if (!String(p.brief || '').trim()) {
                return { ok: false, stage: 'validate', message: '发布掘金文章必须填写摘要：--brief <摘要>（掘金要求约 50-100 字，不可留空）' };
            }
        }

        // ── 创建草稿 ───────────────────────────────────────────────────────
        const createResp = await fetch('https://api.juejin.cn/content_api/v1/article_draft/create', {
            method: 'POST',
            credentials: 'include',
            headers: jsonHeaders,
            body: JSON.stringify({
                brief_content: p.brief || '',
                category_id: categoryId,
                cover_image: '',
                edit_type: 10,
                html_content: '',
                link_url: '',
                mark_content: I.content,
                tag_ids: tagIds,
                theme_ids: [],
                title: I.title,
            }),
        });

        const createText = await createResp.text();
        let createData = null;
        try { createData = JSON.parse(createText); } catch (e) {}

        if (!createResp.ok) {
            return { ok: false, stage: 'create', status: createResp.status, message: createText.slice(0, 300) };
        }
        if (createData && createData.err_no && createData.err_no !== 0) {
            return { ok: false, stage: 'create', status: createResp.status, message: createData.err_msg || ('创建草稿失败: err_no=' + createData.err_no) };
        }
        if (!createData || !createData.data || !createData.data.id) {
            return { ok: false, stage: 'create', status: createResp.status, message: createText.slice(0, 300) };
        }

        const draftId = String(createData.data.id);
        const draftUrl = 'https://juejin.cn/editor/drafts/' + draftId;

        // 仅草稿：返回草稿编辑器地址。
        if (I.draftOnly) {
            return { ok: true, draft: true, id: draftId, url: draftUrl };
        }

        // ── 发布草稿（content_api/v1/article/publish）────────────────────────
        // 实测 body 仅需 {draft_id, sync_to_org, column_ids}（draft_id 为字符串，
        // 服务端 Go 结构体 json:"draft_id,string"）。草稿在 create 时已带齐
        // category/tags/brief，无需单独 update。
        const pubResp = await fetch('https://api.juejin.cn/content_api/v1/article/publish', {
            method: 'POST',
            credentials: 'include',
            headers: jsonHeaders,
            body: JSON.stringify({
                draft_id: draftId,
                sync_to_org: false,
                column_ids: [],
            }),
        });
        const pubText = await pubResp.text();
        let pubData = null;
        try { pubData = JSON.parse(pubText); } catch (e) {}
        if (!pubResp.ok) {
            return { ok: false, stage: 'publish', status: pubResp.status, message: pubText.slice(0, 300), id: draftId, url: draftUrl };
        }
        if (pubData && pubData.err_no && pubData.err_no !== 0) {
            return { ok: false, stage: 'publish', status: pubResp.status, message: pubData.err_msg || ('发布失败: err_no=' + pubData.err_no), id: draftId, url: draftUrl };
        }
        const articleId = pubData && pubData.data && String(pubData.data.article_id || pubData.data.id || '');
        if (!articleId) {
            return { ok: false, stage: 'publish', status: pubResp.status, message: pubText.slice(0, 300), id: draftId, url: draftUrl };
        }
        return { ok: true, draft: false, id: articleId, url: 'https://juejin.cn/post/' + articleId };
    },
};

// ── 正文解析工具（内联，避免依赖 write-shared.js）──────────────────────────
import { readFile, stat } from 'node:fs/promises';

function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此命令需要 --execute 参数才能执行写操作');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '不能同时指定正文参数和 --file，请二选一');
    }
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch {
            throw new CliError('INVALID_INPUT', '文件不存在: ' + file);
        }
        if (!fileStat.isFile()) {
            throw new CliError('INVALID_INPUT', '必须是可读的文本文件: ' + file);
        }
        let raw;
        try { raw = await readFile(file); } catch {
            throw new CliError('INVALID_INPUT', '无法读取文件: ' + file);
        }
        try {
            resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        } catch {
            throw new CliError('INVALID_INPUT', '文件必须是 UTF-8 编码: ' + file);
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

// ── CLI 注册 ──────────────────────────────────────────────────────────────
cli({
    site: 'juejin',
    name: 'article',
    access: 'write',
    description: '发布掘金文章。默认正式发布（需 --category 和 --tags）；加 --draft 仅存草稿。正文默认 Markdown；图片自动转存至掘金图床（字节 ImageX）。',
    domain: 'juejin.cn',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown；传 --html 则视为 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8 编码，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'category', help: '【正式发布必填】分类名（精确匹配）：后端 / 前端 / Android / iOS / 人工智能 / 开发工具 / 代码人生 / 阅读' },
        { name: 'tags', help: '【正式发布必填】标签名，逗号分隔，至少一个（按名精确匹配掘金标签库，如 "Linux,后端"）' },
        { name: 'brief', help: '【正式发布必填】文章摘要，掘金要求约 50-100 字（不做自动截取，必须显式提供）' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿，不发布（草稿无需分类/标签）' },
        { name: 'execute', type: 'boolean', help: '确认执行写操作。不加此参数则拒绝写入。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('掘金文章发布需要浏览器会话');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title)
            throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft);

        // 解析发布参数（分类/标签/摘要）。标签按逗号拆分、去空白、去空项。
        const tags = String(kwargs.tags ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const publishParams = {
            category: typeof kwargs.category === 'string' ? kwargs.category.trim() : '',
            tags,
            brief: typeof kwargs.brief === 'string' ? kwargs.brief : '',
        };

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: juejinProfile,
            publishParams,
        });

        const upN = (result.images.uploaded.length) | 0;
        const failN = (result.images.failed.length) | 0;
        let message = result.draft
            ? '草稿已保存至掘金（需在编辑器内手动发布）'
            : '文章已正式发布至掘金';
        if (upN || failN) {
            message += '；图片：' + upN + ' 张已转存' + (failN ? '，' + failN + ' 张失败' : '');
        }
        return buildResultRow(
            message,
            'article',
            '',
            result.draft ? 'draft' : 'publish',
            { created_target: 'article:' + result.id, created_url: result.url },
        );
    },
});
