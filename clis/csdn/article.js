import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';
import { checkLogin } from '../_shared/article/auth.js';

// ── 内联辅助（无 write-shared.js） ────────────────────────────────────────────
// 参考 clis/zhihu/write-shared.js 精简版：requireExecute / resolvePayload / buildResultRow。

import { readFile, stat } from 'node:fs/promises';

function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此 CSDN 写操作需要加 --execute 参数才能真正执行');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '只能用 <text> 或 --file 之一，不能同时传');
    }
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', `文件不存在：${file}`); }
        if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', `路径必须是可读文本文件：${file}`);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', `文件读取失败：${file}`); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
        catch { throw new CliError('INVALID_INPUT', `文件无法解码为 UTF-8 文本：${file}`); }
    }
    if (!resolved.trim()) throw new CliError('INVALID_INPUT', '正文不能为空');
    return resolved;
}

function buildResultRow(message, targetType, target, outcome, extra = {}, status = 'success') {
    return [{ status, outcome, message, target_type: targetType, target, ...extra }];
}

// ── CSDN 平台 profile ─────────────────────────────────────────────────────────
// 移植自 Wechatsync CSDNAdapter。
// CSDN 使用 Markdown 格式，不需要 HTML 预处理。
// 图片上传为多步：
//   1. 请求 CSDN 签名接口（bizapi.csdn.net），得到华为云 OBS 上传参数；
//   2. multipart POST 到华为云 OBS；
//   3. 从 OBS 响应拿到最终 imageUrl。
// 所有 bizapi 请求需要 HMAC-SHA256 签名（API_KEY / API_SECRET 硬编码在源码里，
// 与 Wechatsync 保持一致）。由于在用户已登录的 editor.csdn.net 标签内运行，
// Origin/Referer 天然正确，无需额外注入 Header 规则。

const csdnProfile = {
    home: 'https://editor.csdn.net/md/',
    outputFormat: 'markdown',
    // CSDN 是 markdown 平台，不需要 preprocessConfig（markdown 不跑 DOM 预处理）。

    // 图片转存：多步签名上传，使用自定义 uploadFn（装不进声明式 spec）。
    image: {
        // 已在 csdn/csdnimg 图床的图不重传
        skip: ['csdnimg.cn', 'csdn.net'],
        // 页面内上传函数：下载图片字节 → 取 CSDN 签名 → 上传到华为云 OBS → 返回新 URL。
        // 注意：此函数以 .toString() 方式注入页面，只能用页面全局 fetch / crypto.subtle，
        // 不能 import / 不能闭包引用外部变量——所有常量必须直接写进函数体。
        uploadFn: async (src, PP) => {
            // CSDN API 签名凭据（与 Wechatsync 保持一致）
            const API_KEY = '203803574';
            const API_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba';

            // 生成 UUID（用作 x-ca-nonce）
            function createUuid() {
                return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                    var r = Math.random() * 16 | 0;
                    var v = c === 'x' ? r : (r & 0x3 | 0x8);
                    return v.toString(16);
                });
            }

            // HMAC-SHA256 签名（使用 Web Crypto API，页面内可用）
            async function hmacSha256(message, secret) {
                var encoder = new TextEncoder();
                var keyData = encoder.encode(secret);
                var messageData = encoder.encode(message);
                var cryptoKey = await crypto.subtle.importKey(
                    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
                );
                var signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
                var bytes = new Uint8Array(signature);
                var binary = '';
                for (var i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
                return btoa(binary);
            }

            // 生成请求签名 Headers（移植自 Wechatsync signRequest，method 参数化）
            async function signRequest(apiPath, method) {
                var nonce = createUuid();
                var signStr = method === 'GET'
                    ? 'GET\n*/*\n\n\n\nx-ca-key:' + API_KEY + '\nx-ca-nonce:' + nonce + '\n' + apiPath
                    : 'POST\n*/*\n\napplication/json\n\nx-ca-key:' + API_KEY + '\nx-ca-nonce:' + nonce + '\n' + apiPath;
                var signature = await hmacSha256(signStr, API_SECRET);
                var headers = {
                    'accept': '*/*',
                    'x-ca-key': API_KEY,
                    'x-ca-nonce': nonce,
                    'x-ca-signature': signature,
                    'x-ca-signature-headers': 'x-ca-key,x-ca-nonce',
                };
                if (method === 'POST') headers['content-type'] = 'application/json';
                return headers;
            }

            // 步骤一：下载图片字节
            var imageResponse = await fetch(src, { credentials: 'omit' });
            if (!imageResponse.ok) throw new Error('图片下载失败: ' + src.slice(0, 80));
            var imageBlob = await imageResponse.blob();

            // 步骤二：确定扩展名。优先从 URL 后缀猜；本机图片是以 data: URI 传进来的（无文件名），
            // 后缀猜不出时退回 blob.type（如 image/png → png）。
            var validExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
            var ext = (src.split('?')[0].split('.').pop() || '').toLowerCase();
            if (validExts.indexOf(ext) === -1) {
                var mt = (imageBlob.type || '').toLowerCase();      // e.g. image/png
                var sub = mt.indexOf('/') !== -1 ? mt.split('/')[1] : '';
                if (sub === 'jpeg') sub = 'jpg';
                ext = validExts.indexOf(sub) !== -1 ? sub : '';
            }
            var validExt = ext || 'jpg';

            // 步骤三：向 CSDN 请求上传签名
            var signApiPath = '/resource-api/v1/image/direct/upload/signature';
            var signHeaders = await signRequest(signApiPath, 'POST');
            var signRes = await fetch('https://bizapi.csdn.net' + signApiPath, {
                method: 'POST',
                credentials: 'include',
                headers: signHeaders,
                body: JSON.stringify({
                    imageTemplate: '',
                    appName: 'direct_blog_markdown',
                    imageSuffix: validExt,
                }),
            });
            var signData = await signRes.json();
            if (signData.code !== 200 || !signData.data) {
                // 获取签名失败，返回原始 URL（降级处理）
                return { url: src };
            }

            // 步骤四：上传到华为云 OBS
            var ud = signData.data;
            var cp = ud.customParam;
            var formData = new FormData();
            formData.append('key', ud.filePath);
            formData.append('policy', ud.policy);
            formData.append('signature', ud.signature);
            formData.append('callbackBody', ud.callbackBody);
            formData.append('callbackBodyType', ud.callbackBodyType);
            formData.append('callbackUrl', ud.callbackUrl);
            formData.append('AccessKeyId', ud.accessId);
            formData.append('x:rtype', cp.rtype);
            formData.append('x:filePath', cp.filePath);
            formData.append('x:isAudit', String(cp.isAudit));
            formData.append('x:x-image-app', cp['x-image-app']);
            formData.append('x:type', cp.type);
            formData.append('x:x-image-suffix', cp['x-image-suffix']);
            formData.append('x:username', cp.username);
            formData.append('file', imageBlob, 'image.' + validExt);

            var obsRes = await fetch(ud.host, {
                method: 'POST',
                body: formData,
            });
            var obsData = await obsRes.json();
            if (obsData.code !== 200 || !obsData.data || !obsData.data.imageUrl) {
                // OBS 上传失败，降级返回原始 URL
                return { url: src };
            }

            return { url: obsData.data.imageUrl };
        },
    },

    // 页面内登录检测（移植自 Wechatsync CSDNAdapter.checkAuth）
    checkAuth: async (PP) => {
        // CSDN API 签名凭据（与 Wechatsync 保持一致）
        var API_KEY = '203803574';
        var API_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba';

        async function hmacSha256(message, secret) {
            var encoder = new TextEncoder();
            var keyData = encoder.encode(secret);
            var messageData = encoder.encode(message);
            var cryptoKey = await crypto.subtle.importKey(
                'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
            );
            var signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
            var bytes = new Uint8Array(signature);
            var binary = '';
            for (var i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
            return btoa(binary);
        }

        var nonce = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
        var apiPath = '/blog-console-api/v3/editor/getBaseInfo';
        var signStr = 'GET\n*/*\n\n\n\nx-ca-key:' + API_KEY + '\nx-ca-nonce:' + nonce + '\n' + apiPath;
        var signature = await hmacSha256(signStr, API_SECRET);

        var res = await fetch('https://bizapi.csdn.net' + apiPath, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'accept': '*/*',
                'x-ca-key': API_KEY,
                'x-ca-nonce': nonce,
                'x-ca-signature': signature,
                'x-ca-signature-headers': 'x-ca-key,x-ca-nonce',
            },
        });
        var data = await res.json();
        if (data.code === 200 && data.data && data.data.name) {
            return {
                isAuthenticated: true,
                userId: data.data.name,
                username: data.data.nickname || data.data.name,
                avatar: data.data.avatar || '',
            };
        }
        return { isAuthenticated: false };
    },

    // 页面内发布函数（移植自 Wechatsync CSDNAdapter.publish，并补正式发布分支）。
    // CSDN 保存草稿/发布是**同一个 saveArticle 接口**：草稿 status:2/pubStatus:'draft'，
    // 正式发布 status:0/pubStatus:'publish'（多源印证：cydmacro 真实抓包 data.txt、
    // k8scat/Articli markdown.go ArticleStatusPublish=0、terwer csdnWebAdaptor addPost）。
    // 同样需要 HMAC-SHA256 签名。
    // I = { title, content, html, draftOnly, params }，content 已完成图片转存（Markdown）。
    // I.params = { categories, tags, description }（均为 CSDN 可选项，缺省即不归专栏/无标签）。
    publish: async (I, PP) => {
        var P = I.params || {};
        var API_KEY = '203803574';
        var API_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba';

        async function hmacSha256(message, secret) {
            var encoder = new TextEncoder();
            var keyData = encoder.encode(secret);
            var messageData = encoder.encode(message);
            var cryptoKey = await crypto.subtle.importKey(
                'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
            );
            var signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
            var bytes = new Uint8Array(signature);
            var binary = '';
            for (var i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
            return btoa(binary);
        }

        async function buildPostHeaders(apiPath) {
            var nonce = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                var r = Math.random() * 16 | 0;
                return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
            var signStr = 'POST\n*/*\n\napplication/json\n\nx-ca-key:' + API_KEY + '\nx-ca-nonce:' + nonce + '\n' + apiPath;
            var sig = await hmacSha256(signStr, API_SECRET);
            return {
                'accept': '*/*',
                'content-type': 'application/json',
                'x-ca-key': API_KEY,
                'x-ca-nonce': nonce,
                'x-ca-signature': sig,
                'x-ca-signature-headers': 'x-ca-key,x-ca-nonce',
            };
        }

        // 草稿 status:2/pubStatus:'draft'；正式发布 status:0/pubStatus:'publish'。
        var isPublish = !I.draftOnly;
        var saveApiPath = '/blog-console-api/v3/mdeditor/saveArticle';
        var saveHeaders = await buildPostHeaders(saveApiPath);
        var saveRes = await fetch('https://bizapi.csdn.net' + saveApiPath, {
            method: 'POST',
            credentials: 'include',
            headers: saveHeaders,
            body: JSON.stringify({
                title: I.title,
                markdowncontent: I.content,
                content: I.html || '',   // CSDN 同时要 HTML（忠实 Wechatsync：传 article.html）
                readType: 'public',
                level: 0,
                tags: P.tags || '',                  // 自由文本，逗号分隔，<=5；可空
                status: isPublish ? 0 : 2,
                categories: P.categories || '',      // 个人专栏名，逗号分隔，<=3；合法值由 `csdn columns` 列举；可空
                type: 'original',
                original_link: '',
                authorized_status: false,
                Description: P.description || '',     // 摘要，<=256；可空（CSDN 自动截取）
                not_auto_saved: '1',
                source: 'pc_mdeditor',
                cover_images: [],
                cover_type: 0,                       // 无封面=0（按 cydmacro/Articli 约定）
                is_new: 1,
                vote_id: 0,
                resource_id: '',
                pubStatus: isPublish ? 'publish' : 'draft',
                creator_activity_id: '',
            }),
        });
        var saveText = await saveRes.text();
        var saveData = null;
        try { saveData = JSON.parse(saveText); } catch (e) {}
        if (!saveRes.ok || !saveData || saveData.code !== 200 || !saveData.data || !saveData.data.id) {
            return {
                ok: false,
                stage: isPublish ? 'publish' : 'save',
                status: saveRes.status,
                message: (saveData && (saveData.msg || saveData.message)) || saveText.slice(0, 300),
            };
        }

        var postId = String(saveData.data.id);
        if (!isPublish) {
            return { ok: true, draft: true, id: postId, url: 'https://editor.csdn.net/md?articleId=' + postId };
        }
        // 正式发布：优先用返回的已发布文章链接，缺省则按 details 拼。
        var pubUrl = (saveData.data && saveData.data.url) || ('https://blog.csdn.net/article/details/' + postId);
        return { ok: true, draft: false, id: postId, url: pubUrl };
    },
};

// 导出 profile 供 whoami.js 复用
export { csdnProfile };

// ── CLI 注册 ──────────────────────────────────────────────────────────────────
cli({
    site: 'csdn',
    name: 'article',
    access: 'write',
    description: '发布 CSDN 博客文章。默认正式发布，加 --draft 仅存草稿。正文默认 Markdown，图片自动转存到 CSDN 图床。',
    domain: 'editor.csdn.net',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '正文（Markdown，与 --file 二选一）' },
        { name: 'file', help: '正文文件路径（UTF-8 编码 Markdown 文件）' },
        { name: 'html', type: 'boolean', help: '将正文视为 HTML 而非 Markdown' },
        { name: 'category', help: '个人专栏名（CSDN 的「分类」即个人专栏），逗号分隔最多 3 个；合法值用 `csdn columns` 列举。可空=不归专栏' },
        { name: 'tags', help: '标签，自由文本逗号分隔最多 5 个（CSDN 标签是自由词，无需查接口）。可空' },
        { name: 'description', help: '文章摘要，最多 256 字（可空，CSDN 自动截取正文）' },
        { name: 'draft', type: 'boolean', help: '仅保存为草稿，不发布' },
        { name: 'execute', type: 'boolean', help: '真正执行写操作，不加此参数则拒绝发布' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('CSDN 文章发布需要浏览器会话');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft);

        const publishParams = {
            categories: typeof kwargs.category === 'string' ? kwargs.category.trim() : '',
            tags: typeof kwargs.tags === 'string' ? kwargs.tags.trim() : '',
            description: typeof kwargs.description === 'string' ? kwargs.description : '',
        };

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: csdnProfile,
            publishParams,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = result.draft ? '已保存 CSDN 草稿' : '已发布 CSDN 文章';
        if (upN || failN) {
            message += `·图片：${upN} 张转存成功${failN ? `，${failN} 张失败` : ''}`;
        }
        // 有图片没转存成功 = 部分成功：正文已发/存草稿，但对应图片会裂。醒目提示 + status=partial，
        // 避免云端 AI 把它当成功而漏掉图（正文与图片是一体的，缺图不算完整发布）。
        if (failN > 0) {
            const detail = result.images.failed
                .map((f) => (f && f.src) || '').filter(Boolean).slice(0, 5).join('；');
            message += `。⚠️ 有图片未成功转存（正文里这些图会裂），请检查图片来源后重发：${detail}`;
        }
        return buildResultRow(
            message,
            'article',
            '',
            result.draft ? 'draft' : 'created',
            {
                created_target: 'article:' + result.id,
                created_url: result.url,
                images_uploaded: upN,
                images_failed: failN,
            },
            failN > 0 ? 'partial' : 'success',
        );
    },
});
