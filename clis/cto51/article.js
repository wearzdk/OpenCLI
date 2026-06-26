import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';

// 51CTO 博客 profile —— 移植自 Wechatsync cto51.ts。
// 51CTO 使用 Markdown 格式，图片走腾讯云 COS 多步上传（getUploadSign → getUploadConfig → POST COS）。
// 发布只能到草稿（平台 API 只暴露 /blogger/draft 接口），需登录态。
export const cto51Profile = {
    home: 'https://blog.51cto.com/blogger/publish',
    outputFormat: 'markdown',

    // checkAuth：解析博主发布页 HTML，取头像 + uid + csrf-token。
    // 移植自 Wechatsync Cto51Adapter.checkAuth()。
    checkAuth: async (PP) => {
        try {
            const response = await fetch('https://blog.51cto.com/blogger/publish', {
                credentials: 'include',
            });
            const html = await response.text();

            // 解析页面获取用户信息（头像链接在 .more.user 的 img 里）
            const imgMatch = html.match(/<li class="more user">\s*<a[^>]*href="([^"]+)"[^>]*>\s*<img[^>]*src="([^"]+)"/);
            if (!imgMatch) {
                return { isAuthenticated: false, error: '未登录或解析页面失败' };
            }

            const userLink = imgMatch[1];
            const avatar = imgMatch[2];
            const uid = userLink.split('/').filter(Boolean).pop() || '';

            // 提取 csrf-token，发布时需要
            const csrfMatch = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
            const csrf = csrfMatch ? csrfMatch[1] : '';

            return {
                isAuthenticated: true,
                userId: uid,
                username: uid,
                avatar: avatar,
                // 把 csrf 挂在结果里方便调试；发布时会在 publish 函数里重新拿
                _csrf: csrf,
            };
        } catch (e) {
            return { isAuthenticated: false, error: String((e && e.message) || e) };
        }
    },

    // 图片转存：三步多步上传（getUploadSign → getUploadConfig → POST COS）。
    // 移植自 Wechatsync Cto51Adapter.uploadImageByUrl()。
    // runtime.fetch → fetch（同源带 cookie，Origin/Referer 天然正确）。
    image: {
        uploadFn: async (src, PP) => {
            // 1. 下载图片字节
            const imgResp = await fetch(src, { credentials: 'omit' });
            if (!imgResp.ok) throw new Error('下载图片失败: ' + imgResp.status);
            const blob = await imgResp.blob();

            const mimeType = blob.type || 'image/jpeg';
            const ext = mimeType.split('/')[1] || 'jpeg';
            const filename = String(Date.now()) + '.' + ext;

            // 2. 获取上传签名
            const signResp = await fetch('https://blog.51cto.com/getUploadSign', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: 'upload_type=image',
            });
            const signJson = await signResp.json();
            if (signJson.code !== 0) throw new Error(signJson.msg || '获取上传签名失败');
            const signData = signJson.data;

            // 3. 获取腾讯云 COS 上传凭证
            const configResp = await fetch('https://blog.51cto.com/getUploadConfig', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: new URLSearchParams({
                    upload_type: 'image',
                    upload_sign: signData.sign,
                    ext: mimeType,
                    name: filename,
                }).toString(),
            });
            const configJson = await configResp.json();
            if (configJson.code !== 0) throw new Error(configJson.msg || '获取上传配置失败');
            const configData = configJson.data;
            const fields = configData.fields;

            // 4. 上传到腾讯云 COS（字段顺序按 Wechatsync 原样保留）
            const formData = new FormData();
            formData.append('key', fields.key);
            formData.append('policy', fields.policy);
            formData.append('x-amz-algorithm', fields['x-amz-algorithm']);
            formData.append('x-amz-signature', fields['x-amz-signature']);
            formData.append('x-amz-credential', fields['x-amz-credential']);
            formData.append('X-Amz-Date', fields['X-Amz-Date']);
            formData.append('Content-Type', mimeType);
            formData.append('file', blob, filename);

            const cosResp = await fetch(configData.url, {
                method: 'POST',
                body: formData,
            });
            if (!cosResp.ok) throw new Error('上传到 COS 失败: ' + cosResp.status);

            // 返回 51CTO CDN 地址
            return { url: 'https://s2.51cto.com/' + fields.key };
        },
        skip: ['s2.51cto.com', '51cto.com'],
    },

    // 发布函数：先取 csrf-token，再 POST /blogger/draft 建草稿。
    // 移植自 Wechatsync Cto51Adapter.publish()。
    // 注意：51CTO 的 API 只暴露草稿接口，发布后始终为草稿状态，需手动审核/提交。
    publish: async (I, PP) => {
        // 重新拿一次 csrf-token（每次发布独立获取，避免会话内漂移）
        let csrf = '';
        try {
            const pageResp = await fetch('https://blog.51cto.com/blogger/publish', { credentials: 'include' });
            const html = await pageResp.text();
            const m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
            if (m) csrf = m[1];
        } catch (e) {
            // 取不到 csrf 继续尝试，提交时服务端会报错
        }

        const postData = new URLSearchParams({
            title: I.title,
            content: I.content,
            pid: '',
            cate_id: '',
            custom_id: '0',
            tag: '',
            abstract: '',
            banner_type: '0',
            blog_type: '1',
            copy_code: '1',
            is_hide: '0',
            top_time: '0',
            is_comment: '0',
            // is_old=0 表示 Markdown 格式（与 Wechatsync 一致：hasMarkdown ? '0' : '2'）
            is_old: '0',
            blog_id: '',
            did: '',
            work_id: '',
            class_id: '',
            subjectId: '',
            import_type: '-1',
            invite_code: '',
            raffle: '',
            orig: '',
            _csrf: csrf,
        });

        const resp = await fetch('https://blog.51cto.com/blogger/draft', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
            },
            body: postData.toString(),
        });

        const resText = await resp.text();
        let resJson = null;
        try { resJson = JSON.parse(resText); } catch (e) {}

        if (!resp.ok || !resJson || resJson.status !== 1 || !resJson.data) {
            return {
                ok: false,
                stage: 'publish',
                status: resp.status,
                message: (resJson && resJson.msg) || resText.slice(0, 300),
            };
        }

        const did = String(resJson.data.did);
        // 51CTO API 只能建草稿，始终返回草稿 URL
        return {
            ok: true,
            id: did,
            url: 'https://blog.51cto.com/blogger/draft/' + did,
            draft: true,
        };
    },
};

// ── CLI 注册 ───────────────────────────────────────────────────────────────────

cli({
    site: 'cto51',
    name: 'article',
    access: 'write',
    description: '发布 51CTO 博客文章（草稿）。正文默认为 Markdown；图片自动转存到 51CTO 图床（腾讯云 COS）。',
    domain: 'blog.51cto.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown；传 --html 则视为 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '将正文视为 HTML 而非 Markdown' },
        { name: 'draft', type: 'boolean', help: '（保留参数，51CTO 只支持保存草稿）' },
        { name: 'execute', type: 'boolean', help: '真正执行创建/发布。没有此参数时命令拒绝写操作。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('51CTO 文章发布需要浏览器会话');

        // 必须传 --execute 才实际写操作
        if (!kwargs.execute) {
            throw new CliError('INVALID_INPUT', '该 51CTO 写操作需要 --execute 参数确认');
        }

        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');

        // 取正文：text 位置参数或 --file 文件
        const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
        const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
        if (text && file) throw new CliError('INVALID_INPUT', '正文与 --file 不能同时使用');

        let body = text ?? '';
        if (file) {
            const { readFile, stat } = await import('node:fs/promises');
            let st;
            try { st = await stat(file); } catch { throw new CliError('INVALID_INPUT', '文件不存在: ' + file); }
            if (!st.isFile()) throw new CliError('INVALID_INPUT', '必须是可读文本文件: ' + file);
            let raw;
            try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', '无法读取文件: ' + file); }
            try { body = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', '文件不是有效 UTF-8 编码: ' + file); }
        }
        if (!body.trim()) throw new CliError('INVALID_INPUT', '正文内容不能为空');

        const draftOnly = true; // 51CTO 只支持草稿，始终为 true

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: cto51Profile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = '已保存 51CTO 草稿';
        if (upN || failN) {
            message += `（图片：${upN} 张已转存${failN ? `，${failN} 张失败` : ''}）`;
        }

        return [{
            status: 'success',
            outcome: 'draft',
            message,
            target_type: 'article',
            target: '',
            created_target: 'article:' + result.id,
            created_url: result.url,
        }];
    },
});
