import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { buildResultRow, requireExecute, resolvePayload } from './write-shared.js';
import { publishArticle } from '../_shared/article/publish.js';

// 知乎专栏 profile —— 接入共享发布编排器（归一 → 预处理 → 图片转存 → 单次 evaluate 发布）。
// 知乎只吃 HTML，所以 Markdown 会先转 HTML；正文里的外链图自动转存到知乎图床。
// 这份 profile 同时是「接新平台怎么写」的参考样板：声明 outputFormat / preprocessConfig /
// 图片 spec + 一个页面内 publish 函数即可，脏活（预处理、转存、防漂移）由基建包办。
export const zhihuProfile = {
    home: 'https://zhuanlan.zhihu.com',
    outputFormat: 'html',
    // 预处理开关移植自 Wechatsync zhihu 适配器 preprocessConfig（Draft.js 口味）。
    preprocessConfig: {
        removeSpecialTags: true,
        removeSpecialTagsWithParent: true,
        processCodeBlocks: true,
        convertSectionToDiv: true,
        removeTrailingBr: true,
        unwrapSingleChildContainers: true,
        unwrapNestedFigures: true,
        compactHtml: true,
        removeEmptyLines: true,
        removeEmptyDivs: true,
        removeNestedEmptyContainers: true,
    },
    // 图片转存：双路径 uploadFn（页面内，带登录态）。
    //   - 远程 URL：知乎「传 URL」接口 /api/uploaded_images，服务端自拉转存（原有已验证路径）。
    //   - data: URI（本机图片经 Node 侧内联而来）：二进制直传——md5 → api.zhihu.com/images
    //     拿 OSS 凭证 →（服务端已有该图则轮询详情取 original_hash）/ OSS PUT（手动 V1 签名）
    //     → pic4.zhimg.com/<object_key>。移植自 Wechatsync ZhihuAdapter（v1/v2 双版核对一致）。
    image: {
        skip: ['zhimg.com'],
        uploadFn: async (src, PP) => {
            // ── 路径一：远程 URL，「传 URL」式服务端转存 ─────────────────────
            if (src.indexOf('data:') !== 0) {
                const resp = await fetch('https://zhuanlan.zhihu.com/api/uploaded_images', {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'x-requested-with': 'fetch',
                        'x-xsrftoken': PP.xsrf(),
                    },
                    body: new URLSearchParams({ url: src, source: 'article' }),
                });
                const txt = await resp.text();
                let data = null; try { data = JSON.parse(txt); } catch (e) {}
                if (!resp.ok || !data || !data.src) {
                    throw new Error('URL 转存失败: HTTP ' + resp.status + ' ' + txt.slice(0, 150));
                }
                return { url: data.src };
            }

            // ── 路径二：data: URI，二进制直传 ────────────────────────────────
            // 注意不能 fetch(data:)——zhuanlan 页面 CSP 拦截，必须 atob 手动解码。
            const blob = PP.dataUriToBlob(src);
            const buf = await blob.arrayBuffer();
            const imageHash = PP.md5(buf);

            // 第一步：请求上传凭证（headers 与 Wechatsync 实际发出的一致：json + x-requested-with）
            const tokenResp = await fetch('https://api.zhihu.com/images', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'x-requested-with': 'fetch' },
                body: JSON.stringify({ image_hash: imageHash, source: 'article' }),
            });
            const tokenTxt = await tokenResp.text();
            let tokenData = null; try { tokenData = JSON.parse(tokenTxt); } catch (e) {}
            if (!tokenResp.ok || !tokenData || !tokenData.upload_file) {
                throw new Error('获取上传凭证失败: HTTP ' + tokenResp.status + ' ' + tokenTxt.slice(0, 150));
            }
            const uploadFile = tokenData.upload_file;

            // 第二步 a：服务端已有该图（state=1）→ 轮询处理完成，取 original_hash
            if (uploadFile.state === 1) {
                for (let i = 0; i < 10; i++) {
                    const dResp = await fetch('https://api.zhihu.com/images/' + uploadFile.image_id, {
                        credentials: 'include',
                        headers: { 'x-requested-with': 'fetch' },
                    });
                    const d = await dResp.json();
                    if (d && (d.status === 'completed' || d.original_hash)) {
                        return { url: 'https://pic4.zhimg.com/' + d.original_hash };
                    }
                    await new Promise((r) => setTimeout(r, 1000));
                }
                throw new Error('图片处理超时（image_id=' + uploadFile.image_id + '）');
            }

            // 第二步 b：新图 → OSS PUT（手动 V1 签名；bucket=zhihu-pics，endpoint 是 cname）
            const token = tokenData.upload_token;
            if (!token || !token.access_id || !token.access_key || !token.access_token) {
                throw new Error('上传凭证响应无效: ' + tokenTxt.slice(0, 150));
            }
            const contentType = blob.type || 'application/octet-stream';
            const ossDate = new Date().toUTCString();
            const ossHeaders = {
                'x-oss-date': ossDate,
                'x-oss-security-token': token.access_token,
                'x-oss-user-agent': 'aliyun-sdk-js/6.8.0',
            };
            const canonicalizedOSSHeaders = Object.keys(ossHeaders).sort()
                .map((k) => k + ':' + ossHeaders[k]).join('\n');
            const stringToSign = 'PUT\n'
                + '\n'                                     // Content-MD5（空）
                + contentType + '\n'
                + ossDate + '\n'
                + canonicalizedOSSHeaders + '\n'
                + '/zhihu-pics/' + uploadFile.object_key;  // CanonicalizedResource

            // HMAC-SHA1 → Base64（页面内 Web Crypto）
            const keyData = new TextEncoder().encode(token.access_key);
            const cryptoKey = await crypto.subtle.importKey(
                'raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
            const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign));
            const signature = btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(sigBuf))));

            const putResp = await fetch('https://zhihu-pics-upload.zhimg.com/' + uploadFile.object_key, {
                method: 'PUT',
                headers: {
                    'Content-Type': contentType,
                    'Authorization': 'OSS ' + token.access_id + ':' + signature,
                    'x-oss-date': ossDate,
                    'x-oss-security-token': token.access_token,
                    'x-oss-user-agent': 'aliyun-sdk-js/6.8.0',
                },
                body: blob,
            });
            if (!putResp.ok) {
                const putTxt = await putResp.text();
                throw new Error('OSS 上传失败: HTTP ' + putResp.status + ' ' + putTxt.slice(0, 150));
            }

            let objectKey = uploadFile.object_key;
            if (blob.type === 'image/gif') objectKey = objectKey + '.gif';
            return { url: 'https://pic4.zhimg.com/' + objectKey };
        },
    },
    // 页面内发布：建草稿 → 写入 → 发布。沿用原适配器验证过的 in-page 流程，仅参数化正文。
    // I = { title, content, draftOnly, params }，content 已完成预处理 + 图片转存。
    // I.params.cover（可空）= 题图，编排器已统一转存成 zhimg URL；PATCH 时以
    // titleImage + isTitleImageFullScreen:false 写入（字段经 Wechatsync v1 /
    // zhihu_obsidian / zhihu_client.py 三方现成代码核实一致）。
    publish: async (I, PP) => {
        let html = I.content;
        // 知乎口味：每张图用 <figure> 包裹。
        html = html.replace(/<img([^>]+?)\/?>/gi, '<figure><img$1></figure>');

        const cover = (I.params && typeof I.params.cover === 'string') ? I.params.cover.trim() : '';
        if (cover && cover.indexOf('zhimg.com') === -1) {
            return { ok: false, stage: 'cover', message: '题图必须是知乎图床（zhimg.com）地址，转存未生效：' + cover.slice(0, 120) };
        }

        const xsrf = PP.xsrf();
        const H = { 'Content-Type': 'application/json', 'x-requested-with': 'fetch', 'x-xsrftoken': xsrf };
        const base = 'https://zhuanlan.zhihu.com/api/articles';

        const cr = await fetch(base + '/drafts', { method: 'POST', credentials: 'include', headers: H, body: JSON.stringify({ title: I.title }) });
        const crText = await cr.text();
        let crData = null; try { crData = JSON.parse(crText); } catch (e) {}
        if (!cr.ok || !crData || !crData.id) {
            return { ok: false, stage: 'create', status: cr.status, message: crText.slice(0, 300) };
        }
        const id = String(crData.id);

        const draftBody = { title: I.title, content: html, table_of_contents: false, delta_time: 30 };
        if (cover) {
            draftBody.titleImage = cover;
            draftBody.isTitleImageFullScreen = false;
        }
        const up = await fetch(base + '/' + id + '/draft', {
            method: 'PATCH', credentials: 'include', headers: H,
            body: JSON.stringify(draftBody),
        });
        if (!up.ok) {
            const upText = await up.text();
            return { ok: false, stage: 'update', status: up.status, message: upText.slice(0, 300), id: id };
        }

        if (I.draftOnly) {
            return { ok: true, draft: true, id: id, url: 'https://zhuanlan.zhihu.com/p/' + id + '/edit' };
        }

        const pub = await fetch(base + '/' + id + '/publish', { method: 'PUT', credentials: 'include', headers: H, body: JSON.stringify({}) });
        const pubText = await pub.text();
        let pubData = null; try { pubData = JSON.parse(pubText); } catch (e) {}
        if (!pub.ok) {
            return { ok: false, stage: 'publish', status: pub.status, message: pubText.slice(0, 300), id: id };
        }
        return { ok: true, draft: false, id: id, url: (pubData && pubData.url) || ('https://zhuanlan.zhihu.com/p/' + id) };
    },
};

cli({
    site: 'zhihu',
    name: 'article',
    access: 'write',
    description: 'Publish a Zhihu article (文章/专栏). Body is Markdown by default; images (incl. local paths) and --cover are auto-rehosted to Zhihu.',
    domain: 'zhuanlan.zhihu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: 'Article title' },
        { name: 'text', positional: true, help: 'Article body (Markdown by default; pass --html for raw HTML)' },
        { name: 'file', help: 'Article body file path (UTF-8, Markdown by default)' },
        { name: 'html', type: 'boolean', help: 'Treat body as raw HTML instead of Markdown' },
        { name: 'cover', help: 'Cover image (题图): local file path or image URL; auto-rehosted to Zhihu (zhimg.com)' },
        { name: 'draft', type: 'boolean', help: 'Save as draft only; do not publish' },
        { name: 'execute', type: 'boolean', help: 'Actually create/publish. Without it the command refuses to write.' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('Browser session required for zhihu article');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title)
            throw new CliError('INVALID_INPUT', 'Article title cannot be empty');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft);
        const cover = typeof kwargs.cover === 'string' ? kwargs.cover.trim() : '';

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: zhihuProfile,
            publishParams: cover ? { cover } : null,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = result.draft ? 'Saved article draft' : 'Published article';
        if (upN || failN) {
            message += ` · images: ${upN} rehosted${failN ? `, ${failN} failed` : ''}`;
        }
        return buildResultRow(
            message,
            'article',
            '',
            result.draft ? 'draft' : 'created',
            { created_target: 'article:' + result.id, created_url: result.url },
        );
    },
});
