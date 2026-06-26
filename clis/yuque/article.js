import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';

// ── 语雀 profile ────────────────────────────────────────────────────────────
// 语雀原生吃 Markdown（转 lake 格式），所以 outputFormat='markdown'，
// 无需 DOM 预处理（preprocessConfig 留空）。
//
// 图片转存需要先建文档拿到 docId（attachable_id），所以图片上传流程
// 统一放在 publish 函数内部，image 字段置 null，不走共享的 spec/uploadFn 管道。
// 转存逻辑：fetch 下载图片字节 → multipart POST 到语雀图床 → 替换 markdown 里的 URL。
//
// 发布流程（对照 Wechatsync yuque.ts）：
//   1. 读 cookie yuque_ctoken 拿 csrf 令牌
//   2. GET /api/mine/common_used 拿 bookId + 用户信息
//   3. POST /api/docs 建草稿文档，拿 docId
//   4. 下载外链图片字节 → PUT /api/upload/attach 转存到语雀图床，替换 markdown
//   5. POST /api/docs/convert md→lake 格式转换
//   6. PUT /api/docs/{id}/content 保存正文
//   7. 若非 draftOnly：PUT /api/docs/{id}/publish 发布

export const yuqueProfile = {
    home: 'https://www.yuque.com/dashboard',
    outputFormat: 'markdown',
    // markdown 平台不需要 DOM 预处理
    preprocessConfig: null,
    // 图片转存在 publish 内部处理（依赖 docId），不走共享 spec/uploadFn
    image: null,

    // 页面内发布函数（全程 fetch + document.cookie，同源带 cookie）
    // I = { title, content, draftOnly }
    // PP = 页面运行时（PP.cookie 取 cookie）
    publish: async (I, PP) => {
        // ── 1. 取 csrf 令牌（来自 cookie yuque_ctoken）────────────────────────
        const csrfToken = PP.cookie('yuque_ctoken');
        if (!csrfToken) {
            return { ok: false, stage: 'auth', message: '未检测到语雀登录态，请先在 Chrome 中登录语雀（缺少 yuque_ctoken cookie）' };
        }

        const H = {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken,
        };

        // ── 2. 拿 bookId（common_used 接口）──────────────────────────────────
        const cmResp = await fetch('https://www.yuque.com/api/mine/common_used', {
            method: 'GET',
            credentials: 'include',
            headers: H,
        });
        let cmData = null;
        try { cmData = await cmResp.json(); } catch (e) {}
        if (!cmResp.ok || !cmData?.data?.books?.length) {
            return {
                ok: false,
                stage: 'auth',
                status: cmResp.status,
                message: '无法获取语雀知识库列表，请确认已登录语雀',
            };
        }
        const firstBook = cmData.data.books[0];
        const bookId = firstBook.target_id;

        // ── 3. 建草稿文档，拿 docId ──────────────────────────────────────────
        const crResp = await fetch('https://www.yuque.com/api/docs', {
            method: 'POST',
            credentials: 'include',
            headers: H,
            body: JSON.stringify({
                title: I.title,
                type: 'Doc',
                format: 'lake',
                book_id: bookId,
                status: 0,
            }),
        });
        let crData = null;
        try { crData = await crResp.json(); } catch (e) {}
        if (!crResp.ok || !crData?.data?.id) {
            return {
                ok: false,
                stage: 'create',
                status: crResp.status,
                message: (crData?.message) || '创建语雀草稿文档失败',
            };
        }
        const docId = crData.data.id;
        const draftUrl = 'https://www.yuque.com/go/doc/' + docId + '/edit';

        // ── 4. 图片转存（需要 docId 作为 attachable_id）─────────────────────
        // 从 markdown 里提取所有图片引用，跳过已在语雀/nlark 图床的图片
        let markdown = I.content;
        const skipDomains = ['yuque.com', 'cdn.nlark.com'];
        const imgRe = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)/g;
        const refs = [];
        let m;
        while ((m = imgRe.exec(markdown)) !== null) {
            refs.push({ full: m[0], alt: m[1], src: m[2] });
        }
        const uploaded = [];
        const failed = [];
        const uploadUrl = 'https://www.yuque.com/api/upload/attach?attachable_type=Doc&attachable_id=' + docId + '&type=image';
        for (let i = 0; i < refs.length; i++) {
            const ref = refs[i];
            const src = ref.src;
            if (!src) continue;
            if (src.indexOf('data:') === 0) continue;
            if (skipDomains.some(function (d) { return src.indexOf(d) !== -1; })) continue;
            try {
                const imgResp = await fetch(src, { credentials: 'omit' });
                if (!imgResp.ok) throw new Error('图片下载失败 HTTP ' + imgResp.status);
                const blob = await imgResp.blob();
                const fd = new FormData();
                fd.append('file', blob, 'image.jpg');
                const upResp = await fetch(uploadUrl, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'x-csrf-token': csrfToken },
                    body: fd,
                });
                let upData = null;
                try { upData = await upResp.json(); } catch (e) {}
                if (!upResp.ok || !upData?.data?.url) {
                    throw new Error((upData && upData.message) || ('图片上传失败 HTTP ' + upResp.status));
                }
                const newUrl = upData.data.url;
                markdown = markdown.split(ref.full).join('![' + ref.alt + '](' + newUrl + ')');
                uploaded.push({ src: src.slice(0, 120), url: newUrl });
            } catch (e) {
                failed.push({ src: src.slice(0, 120), error: String((e && e.message) || e) });
            }
        }

        // ── 5. markdown→lake 格式转换 ─────────────────────────────────────────
        const cvResp = await fetch('https://www.yuque.com/api/docs/convert', {
            method: 'POST',
            credentials: 'include',
            headers: H,
            body: JSON.stringify({ from: 'markdown', to: 'lake', content: markdown }),
        });
        let cvData = null;
        try { cvData = await cvResp.json(); } catch (e) {}
        if (!cvResp.ok || !cvData?.data?.content) {
            return {
                ok: false,
                stage: 'convert',
                status: cvResp.status,
                message: '内容格式转换失败（markdown→lake）',
                id: String(docId),
                uploaded: uploaded,
                failed: failed,
            };
        }
        const lakeContent = cvData.data.content;
        const lakeBody = '<div class="lake-content" typography="traditional">' + lakeContent + '</div>';

        // ── 6. 保存正文 ────────────────────────────────────────────────────────
        const svResp = await fetch('https://www.yuque.com/api/docs/' + docId + '/content', {
            method: 'PUT',
            credentials: 'include',
            headers: H,
            body: JSON.stringify({
                format: 'lake',
                body_asl: lakeContent,
                body: lakeBody,
                body_html: lakeBody,
                draft_version: 0,
                sync_dynamic_data: false,
                save_type: 'auto',
                edit_type: 'Lake',
            }),
        });
        if (!svResp.ok) {
            let svText = '';
            try { svText = await svResp.text(); } catch (e) {}
            return {
                ok: false,
                stage: 'save',
                status: svResp.status,
                message: ('保存正文失败：' + svText.slice(0, 300)),
                id: String(docId),
                uploaded: uploaded,
                failed: failed,
            };
        }

        // ── 7. 发布（非草稿模式）─────────────────────────────────────────────
        if (!I.draftOnly) {
            const pbResp = await fetch('https://www.yuque.com/api/docs/' + docId + '/publish', {
                method: 'PUT',
                credentials: 'include',
                headers: H,
                body: JSON.stringify({ status: 1 }),
            });
            if (!pbResp.ok) {
                let pbText = '';
                try { pbText = await pbResp.text(); } catch (e) {}
                return {
                    ok: false,
                    stage: 'publish',
                    status: pbResp.status,
                    message: ('发布失败：' + pbText.slice(0, 300)),
                    id: String(docId),
                    url: draftUrl,
                    uploaded: uploaded,
                    failed: failed,
                };
            }
        }

        return {
            ok: true,
            id: String(docId),
            url: draftUrl,
            draft: Boolean(I.draftOnly),
            uploaded: uploaded,
            failed: failed,
        };
    },
};

cli({
    site: 'yuque',
    name: 'article',
    access: 'write',
    description: '发布语雀文章（知识库文档）。正文默认为 Markdown，外链图片自动转存到语雀图床。',
    domain: 'www.yuque.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（Markdown 格式；或用 --file 读文件）' },
        { name: 'file', help: '正文文件路径（UTF-8，Markdown 格式）' },
        { name: 'html', type: 'boolean', help: '把正文当 HTML 输入（语雀仍转 lake 发布）' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿，不发布' },
        { name: 'execute', type: 'boolean', help: '实际执行写操作。不加此参数命令拒绝写入。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('语雀文章发布需要浏览器会话');
        if (!kwargs.execute) {
            throw new CliError('INVALID_INPUT', '此命令需要加 --execute 才会实际写入（防误操作）');
        }
        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');

        // 取正文
        let body = '';
        const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
        const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
        if (text && file) throw new CliError('INVALID_INPUT', '正文和 --file 不能同时使用');
        if (file) {
            const { readFile, stat } = await import('node:fs/promises');
            let fileStat;
            try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', `文件不存在：${file}`); }
            if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', `路径不是文件：${file}`);
            let raw;
            try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', `文件无法读取：${file}`); }
            try { body = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', `文件无法以 UTF-8 解码：${file}`); }
        } else {
            body = text ?? '';
        }
        if (!body.trim()) throw new CliError('INVALID_INPUT', '正文不能为空');

        const draftOnly = Boolean(kwargs.draft);

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: yuqueProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = result.draft ? '已保存语雀草稿' : '语雀文章发布成功';
        if (upN || failN) {
            message += `（图片：${upN} 张已转存${failN ? `，${failN} 张失败` : ''}）`;
        }

        const outcome = result.draft ? 'draft' : 'created';
        return [{
            status: 'success',
            outcome,
            message,
            target_type: 'article',
            target: '',
            created_target: 'article:' + result.id,
            created_url: result.url,
        }];
    },
});
