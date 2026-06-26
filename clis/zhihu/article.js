import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { buildResultRow, requireExecute, resolvePayload } from './write-shared.js';
import { publishArticle } from '../_shared/article/publish.js';

// 知乎专栏 profile —— 接入共享发布编排器（归一 → 预处理 → 图片转存 → 单次 evaluate 发布）。
// 知乎只吃 HTML，所以 Markdown 会先转 HTML；正文里的外链图自动转存到知乎图床。
// 这份 profile 同时是「接新平台怎么写」的参考样板：声明 outputFormat / preprocessConfig /
// 图片 spec + 一个页面内 publish 函数即可，脏活（预处理、转存、防漂移）由基建包办。
const zhihuProfile = {
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
    // 图片转存：知乎「传 URL」式——把外链图 URL 交给服务端自拉转存（不下载字节）。
    image: {
        spec: {
            url: 'https://zhuanlan.zhihu.com/api/uploaded_images',
            method: 'POST',
            bodyType: 'form',
            body: { url: '{src}', source: 'article' },
            responsePath: 'src',
            xsrf: true,
        },
        skip: ['zhimg.com'],
    },
    // 页面内发布：建草稿 → 写入 → 发布。沿用原适配器验证过的 in-page 流程，仅参数化正文。
    // I = { title, content, draftOnly }，content 已完成预处理 + 图片转存。
    publish: async (I, PP) => {
        let html = I.content;
        // 知乎口味：每张图用 <figure> 包裹。
        html = html.replace(/<img([^>]+?)\/?>/gi, '<figure><img$1></figure>');

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

        const up = await fetch(base + '/' + id + '/draft', {
            method: 'PATCH', credentials: 'include', headers: H,
            body: JSON.stringify({ title: I.title, content: html, table_of_contents: false, delta_time: 30 }),
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
    description: 'Publish a Zhihu article (文章/专栏). Body is Markdown by default; images are auto-rehosted to Zhihu.',
    domain: 'zhuanlan.zhihu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: 'Article title' },
        { name: 'text', positional: true, help: 'Article body (Markdown by default; pass --html for raw HTML)' },
        { name: 'file', help: 'Article body file path (UTF-8, Markdown by default)' },
        { name: 'html', type: 'boolean', help: 'Treat body as raw HTML instead of Markdown' },
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

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: zhihuProfile,
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
