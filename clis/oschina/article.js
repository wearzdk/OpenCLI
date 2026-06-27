import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { readFile, stat } from 'node:fs/promises';
import { publishArticle } from '../_shared/article/publish.js';

// ── 开源中国文章发布 profile ───────────────────────────────────────────────
// 移植自 Wechatsync oschina 适配器。
// 开源中国直接吃 Markdown；图片走「下载字节 → multipart POST」到
// /oschinapi/ai/creation/project/uploadDetail，返回 result 字段即新 URL。
// 发布只有草稿接口（save_draft）——没有独立的「直接发布」步骤，draftOnly 固定为 true。
//
// 注意：checkAuth / publish 都是页面内函数（.toString() 注入），只能用页面全局（fetch/document）。

export const oschinaProfile = {
    home: 'https://my.oschina.net',
    outputFormat: 'markdown',
    // 图片：先 fetch 下载字节，再 multipart 上传。
    // 上传接口需要 userId 作为路径参数，但 userId 只有登录后才有，
    // 所以这里用自定义 uploadFn 在页面内先取 userId 再上传。
    image: {
        // binary-multipart 上传：把图片字节 POST 到开源中国图床。
        // 开源中国上传接口不需要 userId 路径参数，直接 POST 带 cookie 即可。
        spec: {
            url: 'https://apiv1.oschina.net/oschinapi/ai/creation/project/uploadDetail',
            method: 'POST',
            bodyType: 'binary-multipart',
            fileField: 'file',
            fileName: 'image',
            body: {},
            // responsePath 指向 result 字段（直接是新 URL 字符串）
            responsePath: 'result',
        },
        skip: ['apiv1.oschina.net', 'oscimg.oschina.net', 'static.oschina.net'],
    },
    // checkAuth：在开源中国页面内查询当前登录用户信息。
    checkAuth: async () => {
        const resp = await fetch('https://apiv1.oschina.net/oschinapi/user/myDetails', {
            credentials: 'include',
        });
        if (!resp.ok) {
            return { isAuthenticated: false, error: 'HTTP ' + resp.status };
        }
        let data = null;
        try { data = await resp.json(); } catch (e) { return { isAuthenticated: false, error: '解析响应失败' }; }
        if (!data || !data.success || !data.result || !data.result.userId) {
            return { isAuthenticated: false, error: (data && data.message) || '未登录' };
        }
        const userId = String(data.result.userId);
        const username = (data.result.userVo && data.result.userVo.name) || userId;
        const avatar = (data.result.userVo && data.result.userVo.portraitUrl) || '';
        return { isAuthenticated: true, userId, username, avatar };
    },
    // publish：保存为草稿（开源中国只提供草稿接口，后续须在网站手动发布）。
    // I = { title, content, draftOnly, params }，content 已完成图片转存，为 Markdown 正文。
    // I.params = { category }（个人博客分类名，可空=不分类；按名解析为 catalog id）。
    // 草稿：POST api/draft/save_draft（contentType 1=md/2=html）。
    // 正式发布：POST blog/web/add（contentType 0=html/1=md，与草稿相反——已从 OSChina 自家
    //   bundle writeType-CEJXAhyC.js 的 `ee.value==='1'?0:1` 确认；type:'1'=原创）。
    publish: async (I) => {
        const P = I.params || {};
        // 先取当前用户 ID（publish 在页面内跑，无法从 Node 侧传入）
        let userId = '';
        try {
            const authResp = await fetch('https://apiv1.oschina.net/oschinapi/user/myDetails', {
                credentials: 'include',
            });
            const authData = await authResp.json();
            if (authData && authData.success && authData.result && authData.result.userId) {
                userId = String(authData.result.userId);
            }
        } catch (e) {}

        if (!userId) {
            return { ok: false, stage: 'auth', status: 401, message: '未登录开源中国，无法获取用户 ID' };
        }

        // 解析博客分类名 → catalog id（精确匹配，找不到报错不 fallback；不传则 0=不分类）
        let catalog = 0;
        if (P.category) {
            let list = [];
            try {
                const cr = await fetch('https://apiv1.oschina.net/oschinapi/blog_catalog/list_by_user', { credentials: 'include' });
                const cd = await cr.json();
                list = (cd && cd.result) || [];
            } catch (e) {
                return { ok: false, stage: 'category', message: '获取开源中国博客分类失败：' + String((e && e.message) || e) };
            }
            const hit = list.find((c) => String(c.name) === String(P.category));
            if (!hit) {
                return { ok: false, stage: 'category', message: '未找到博客分类「' + P.category + '」，可选：' + (list.map((c) => c.name).join(' / ') || '（你还没有任何分类）') };
            }
            catalog = hit.id;
        }

        // ── 草稿：save_draft ────────────────────────────────────────────────
        if (I.draftOnly) {
            const resp = await fetch('https://apiv1.oschina.net/oschinapi/api/draft/save_draft', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: I.title,
                    user: Number(userId),
                    content: I.content,
                    contentType: 1, // save_draft：1=Markdown
                    catalog,
                    originUrl: '',
                    privacy: true,
                    disableComment: false,
                }),
            });
            const text = await resp.text();
            let data = null;
            try { data = JSON.parse(text); } catch (e) {}
            if (!resp.ok || !data || !data.success || !data.result || !data.result.id) {
                return { ok: false, stage: 'save_draft', status: resp.status, message: (data && data.message) || text.slice(0, 300) };
            }
            const draftId = String(data.result.id);
            return { ok: true, draft: true, id: draftId, url: 'https://my.oschina.net/u/' + userId + '/blog/write/draft/' + draftId };
        }

        // ── 正式发布：blog/web/add ──────────────────────────────────────────
        const resp = await fetch('https://apiv1.oschina.net/oschinapi/blog/web/add', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: I.title,
                content: I.content,
                contentType: 1,   // blog/web/add：1=Markdown（与 save_draft 相反，已 bundle 确认）
                type: '1',        // 1=原创
                originUrl: '',
                catalog,
                privacy: false,   // 公开发布
                disableComment: false,
                isAiRelated: false,
                user: Number(userId),
            }),
        });
        const text = await resp.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) {}
        if (!resp.ok || !data || data.code !== 200 || data.result == null) {
            return { ok: false, stage: 'publish', status: resp.status, message: (data && (data.message || data.msg)) || text.slice(0, 300) };
        }
        const blogId = String(data.result);
        return { ok: true, draft: false, id: blogId, url: 'https://my.oschina.net/u/' + userId + '/blog/' + blogId };
    },
};

// ── 辅助函数（内联，避免引 write-shared.js——该文件是知乎专属的）─────────────

function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '发布开源中国文章需要 --execute 参数');
    }
}

function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '正文和文件路径只能二选一，不能同时指定');
    }
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', '文件不存在：' + file); }
        if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', '必须指定可读的文本文件：' + file);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', '文件读取失败：' + file); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', '文件编码不是 UTF-8：' + file); }
    }
    if (!resolved.trim()) throw new CliError('INVALID_INPUT', '文章正文不能为空');
    return resolved;
}

cli({
    site: 'oschina',
    name: 'article',
    access: 'write',
    description: '发布文章到开源中国博客。默认正式发布，加 --draft 仅存草稿。正文默认 Markdown，外链图片自动转存到开源中国图床。',
    domain: 'my.oschina.net',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown；--html 表示原始 HTML）' },
        { name: 'file', help: '从文件读取正文（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'category', help: '个人博客分类名（精确匹配），合法值用 `oschina catalogs` 列举；可空=不分类' },
        { name: 'draft', type: 'boolean', help: '仅存草稿，不发布' },
        { name: 'execute', type: 'boolean', help: '真正执行写操作；不加此参数命令拒绝写入' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('开源中国文章发布需要浏览器会话');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft);
        const publishParams = {
            category: typeof kwargs.category === 'string' ? kwargs.category.trim() : '',
        };

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: oschinaProfile,
            publishParams,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = result.draft ? '已保存到开源中国草稿箱' : '已正式发布到开源中国博客';
        if (upN || failN) {
            message += `·图片：${upN} 张已转存${failN ? `，${failN} 张失败` : ''}`;
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

export const __test__ = { oschinaProfile, requireExecute, buildResultRow, resolvePayload };
