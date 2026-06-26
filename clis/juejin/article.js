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
    // 移植自 Wechatsync JuejinAdapter.publish()
    // 掘金只支持创建草稿（API 不提供一步发布，发布需在编辑器内手动操作）。
    // I = { title, content, draftOnly }；content 已完成图片转存（markdown）。
    publish: async (I, PP) => {
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

        // ── 创建草稿 ───────────────────────────────────────────────────────
        const createHeaders = {
            'Content-Type': 'application/json',
        };
        if (csrfToken) createHeaders['x-secsdk-csrf-token'] = csrfToken;

        const createResp = await fetch('https://api.juejin.cn/content_api/v1/article_draft/create', {
            method: 'POST',
            credentials: 'include',
            headers: createHeaders,
            body: JSON.stringify({
                brief_content: '',
                category_id: '0',
                cover_image: '',
                edit_type: 10,
                html_content: 'deprecated',
                link_url: '',
                mark_content: I.content,
                tag_ids: [],
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

        // 掘金 API 仅支持草稿创建；发布须在编辑器内手动操作。
        // 无论 draftOnly 值，均返回草稿 URL（draft:true）。
        return { ok: true, draft: true, id: draftId, url: draftUrl };
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
    description: '发布掘金文章（草稿）。正文默认为 Markdown；图片自动转存至掘金图床（字节 ImageX）。',
    domain: 'juejin.cn',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown；传 --html 则视为 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8 编码，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿，不发布（掘金 API 目前只支持草稿，此选项保留兼容性）' },
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

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: juejinProfile,
        });

        const upN = (result.images.uploaded.length) | 0;
        const failN = (result.images.failed.length) | 0;
        let message = '草稿已保存至掘金（需在编辑器内手动发布）';
        if (upN || failN) {
            message += '；图片：' + upN + ' 张已转存' + (failN ? '，' + failN + ' 张失败' : '');
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
