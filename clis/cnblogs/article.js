import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';

// 博客园 profile —— 接入共享发布编排器。
// 博客园原生支持 Markdown，所以 outputFormat='markdown'：正文直接发 markdown，
// 不需要 DOM 预处理，只做图片转存（multipart 上传到 upload.cnblogs.com）。
//
// XSRF-TOKEN：博客园 i.cnblogs.com API 需要请求头 x-xsrf-token，值来自 cookie XSRF-TOKEN。
// 由于我们在用户已登录的 i.cnblogs.com 标签页内跑，cookie 天然可读，用 PP.cookie() 直取。
//
// 图片上传：Wechatsync 使用 https://upload.cnblogs.com/v2/images/cors-upload，
// multipart POST，字段 image（blob）+ app + uploadType，返回 { data: "https://..." }。
// 由于需要多步（先 fetch 下字节，再 multipart 上传），使用 uploadFn 模式。
export const cnblogsProfile = {
    home: 'https://i.cnblogs.com/posts/edit',
    outputFormat: 'markdown',

    // 图片转存：下载字节 → multipart POST 到博客园图床。
    // uploadFn 模式：在页面内执行，fetch 天然带 cookie 和正确 Origin/Referer。
    image: {
        uploadFn: async (src, PP) => {
            // 从 cookie 取 XSRF-TOKEN
            const xsrfToken = PP.cookie('XSRF-TOKEN');
            if (!xsrfToken) {
                throw new Error('未找到 XSRF-TOKEN cookie，请确认已登录博客园');
            }

            // 下载图片字节
            const imgResp = await fetch(src, { credentials: 'omit' });
            if (!imgResp.ok) {
                throw new Error('图片下载失败: ' + src + '（HTTP ' + imgResp.status + '）');
            }
            const blob = await imgResp.blob();

            // 构建 multipart 表单
            const fd = new FormData();
            fd.append('image', blob, 'image.png');
            fd.append('app', 'blog');
            fd.append('uploadType', 'Select');

            // 上传到博客园图床
            const uploadResp = await fetch('https://upload.cnblogs.com/v2/images/cors-upload', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'x-xsrf-token': xsrfToken,
                },
                body: fd,
            });

            const respText = await uploadResp.text();
            if (!uploadResp.ok) {
                throw new Error('图片上传失败: HTTP ' + uploadResp.status + ' ' + respText.slice(0, 150));
            }

            let respJson = null;
            try { respJson = JSON.parse(respText); } catch (e) {}
            if (!respJson) {
                throw new Error('图片上传失败: 响应不是 JSON - ' + respText.slice(0, 100));
            }

            // 博客园返回格式：{ data: "https://img2024.cnblogs.com/..." }
            const imageUrl = respJson.data || respJson.url || respJson.imageUrl || respJson.src;
            if (!imageUrl || typeof imageUrl !== 'string') {
                throw new Error('图片上传失败: 无法解析图片 URL - ' + JSON.stringify(respJson).slice(0, 150));
            }

            return { url: imageUrl };
        },
        skip: ['cnblogs.com'],
    },

    // 页面内发布函数：POST 到博客园 API 创建文章草稿，再按需发布。
    // Wechatsync 的 publish 直接创建 isDraft:true 的草稿，draftOnly=false 时单独更新发布状态。
    // 博客园 API：POST https://i.cnblogs.com/api/posts → { id, blogId }
    // 发布：PATCH https://i.cnblogs.com/api/posts/{id} with isPublished:true, isDraft:false
    publish: async (I, PP) => {
        const xsrfToken = PP.cookie('XSRF-TOKEN');
        if (!xsrfToken) {
            return { ok: false, stage: 'auth', status: 401, message: '未找到 XSRF-TOKEN cookie，请确认已登录博客园并在 i.cnblogs.com 下访问过' };
        }

        const headers = {
            'Content-Type': 'application/json',
            'x-xsrf-token': xsrfToken,
        };

        // 第一步：创建草稿（isDraft: true）
        const createBody = {
            id: null,
            postType: 2,
            accessPermission: 0,
            title: I.title,
            url: null,
            postBody: I.content,
            categoryIds: null,
            categories: null,
            collectionIds: [],
            inSiteCandidate: false,
            inSiteHome: false,
            siteCategoryId: null,
            blogTeamIds: null,
            isPublished: false,
            displayOnHomePage: false,
            isAllowComments: true,
            includeInMainSyndication: false,
            isPinned: false,
            showBodyWhenPinned: false,
            isOnlyForRegisterUser: false,
            isUpdateDateAdded: false,
            entryName: null,
            description: null,
            featuredImage: null,
            tags: null,
            password: null,
            publishAt: null,
            datePublished: new Date().toISOString(),
            dateUpdated: null,
            isMarkdown: true,
            isDraft: true,
            autoDesc: null,
            changePostType: false,
            blogId: 0,
            author: null,
            removeScript: false,
            clientInfo: null,
            changeCreatedTime: false,
            canChangeCreatedTime: false,
            isContributeToImpressiveBugActivity: false,
            usingEditorId: 5,
            sourceUrl: null,
        };

        const createResp = await fetch('https://i.cnblogs.com/api/posts', {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify(createBody),
        });

        const createText = await createResp.text();
        if (!createResp.ok) {
            return { ok: false, stage: 'create', status: createResp.status, message: createText.slice(0, 300) };
        }

        let createData = null;
        try { createData = JSON.parse(createText); } catch (e) {}
        if (!createData || !createData.id) {
            return { ok: false, stage: 'create', status: createResp.status, message: '创建草稿失败: ' + createText.slice(0, 300) };
        }

        const postId = String(createData.id);
        const draftUrl = 'https://i.cnblogs.com/articles/edit;postId=' + postId;

        if (I.draftOnly) {
            return { ok: true, draft: true, id: postId, url: draftUrl };
        }

        // 第二步：发布（isPublished: true, isDraft: false）
        const publishResp = await fetch('https://i.cnblogs.com/api/posts/' + postId, {
            method: 'PATCH',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify({
                isPublished: true,
                isDraft: false,
                displayOnHomePage: true,
            }),
        });

        const publishText = await publishResp.text();
        if (!publishResp.ok) {
            return { ok: false, stage: 'publish', status: publishResp.status, message: publishText.slice(0, 300), id: postId };
        }

        // 发布成功后文章 URL 为 https://www.cnblogs.com/{username}/{postId}，但我们这里无法拿到 username，
        // 用草稿编辑 URL 兜底；如果响应里有更准确的 URL 就用它。
        let pubData = null;
        try { pubData = JSON.parse(publishText); } catch (e) {}
        const pubUrl = (pubData && pubData.url) || ('https://www.cnblogs.com/?id=' + postId);

        return { ok: true, draft: false, id: postId, url: pubUrl };
    },
};

// 鉴权 profile（whoami 复用）
export const cnblogsAuthProfile = {
    // CurrentUserInfo 接口在 home.cnblogs.com 下，必须导航到同源页才能带 cookie 读取，
    // 否则从 www.cnblogs.com 跨子域 fetch 触发 CORS、被 catch 吞掉、whoami 永远报未登录。
    home: 'https://home.cnblogs.com',
    // checkAuth：在页面内 fetch 博客园「当前用户」接口，解析 HTML 取用户名。
    // 移植自 Wechatsync checkAuth()，URL: https://home.cnblogs.com/user/CurrentUserInfo
    checkAuth: async (PP) => {
        try {
            const resp = await fetch('https://home.cnblogs.com/user/CurrentUserInfo', {
                method: 'GET',
                credentials: 'include',
            });
            if (!resp.ok) {
                return { isAuthenticated: false, error: 'HTTP ' + resp.status };
            }
            const text = await resp.text();
            // 页面结构: <a href="/u/xxx/"><img class="pfs" src="..."></a>
            const linkMatch = text.match(/href="\/u\/([^/]+)\/"/);
            const avatarMatch = text.match(/<img[^>]+class="pfs"[^>]+src="([^"]+)"/);
            if (!linkMatch) {
                return { isAuthenticated: false };
            }
            const uid = linkMatch[1];
            return {
                isAuthenticated: true,
                userId: uid,
                username: uid,
                avatar: avatarMatch ? avatarMatch[1] : '',
            };
        } catch (e) {
            return { isAuthenticated: false, error: String((e && e.message) || e) };
        }
    },
};

// ── 辅助函数（直接内联，不依赖外部 write-shared.js）─────────────────────────

function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此命令需要 --execute 参数才会实际写入博客园');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '不能同时使用 <text> 和 --file，选其一即可');
    }
    let resolved = text ?? '';
    if (file) {
        const { readFile, stat } = await import('node:fs/promises');
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', '文件不存在: ' + file); }
        if (!fileStat.isFile()) { throw new CliError('INVALID_INPUT', '必须是可读文本文件: ' + file); }
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', '文件读取失败: ' + file); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', '文件不是有效 UTF-8 编码: ' + file); }
    }
    if (!resolved.trim()) {
        throw new CliError('INVALID_INPUT', '正文不能为空');
    }
    return resolved;
}

function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

// ── CLI 注册 ─────────────────────────────────────────────────────────────────

cli({
    site: 'cnblogs',
    name: 'article',
    access: 'write',
    description: '发布博客园文章（Markdown）。正文默认 Markdown；图片自动转存到博客园图床。',
    domain: 'cnblogs.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（Markdown，默认；--html 时按 HTML 处理）' },
        { name: 'file', help: '从文件读取正文（UTF-8，Markdown 默认）' },
        { name: 'html', type: 'boolean', help: '将正文当作原始 HTML 而非 Markdown' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿，不发布' },
        { name: 'execute', type: 'boolean', help: '实际执行写入。不加此参数命令拒绝写入。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('博客园文章发布需要浏览器会话');
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
            profile: cnblogsProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = result.draft ? '已保存博客园草稿' : '已发布博客园文章';
        if (upN || failN) {
            message += '·图片: ' + upN + ' 张已转存' + (failN ? '，' + failN + ' 张失败' : '');
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
