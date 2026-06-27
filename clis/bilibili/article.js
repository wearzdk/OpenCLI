import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';
import { readFile, stat } from 'node:fs/promises';

// ── 本地辅助（仿 zhihu/write-shared.js，仅在 Node 侧用）────────────────────

function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此写操作需要 --execute 才会真正提交');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '正文和 --file 只能选一个');
    }
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch {
            throw new CliError('INVALID_INPUT', `文件不存在：${file}`);
        }
        if (!fileStat.isFile()) {
            throw new CliError('INVALID_INPUT', `--file 必须是可读的文本文件：${file}`);
        }
        let raw;
        try { raw = await readFile(file); } catch {
            throw new CliError('INVALID_INPUT', `文件无法读取：${file}`);
        }
        try {
            resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        } catch {
            throw new CliError('INVALID_INPUT', `文件无法以 UTF-8 解码：${file}`);
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

// ── B站专栏 profile ──────────────────────────────────────────────────────────
//
// 移植自 Wechatsync BilibiliAdapter（packages/core/src/adapters/platforms/bilibili.ts），
// 在「建草稿」之上增量补齐「正式发布」分支（经典版专栏 API）。
// 原适配器通过 declarativeNetRequest 注入 Origin/Referer；opencli 在用户已登录的页面
// 标签内跑，同源天然携带 cookie，故删除所有 HEADER_RULES / withHeaderRules / runtime.fetch。
//
// B站专栏（opus/article）写作页：https://member.bilibili.com/platform/upload/text
//
// 经典版专栏发布两步（已 re-fetch GitHub 出处核验）：
//   1) 建草稿：POST /x/article/creative/draft/addupdate（save=0）→ 拿 data.aid。
//   2) 正式发布：POST /x/article/creative/article/submit（带上一步 aid）。
//      出处 MaxSecurity/BiliExper BiliClient/BiliApi.py：submit url + post_data
//      {aid,title,content,category,list_id,tid:4(注「4为专栏封面单图,3为专栏封面三图」),
//       reprint:0,media_id:0,spoiler:0,original,csrf}；响应 {code:0,data:{aid}}，
//      成功页 https://www.bilibili.com/read/cv{aid}；HTTP 412=风控拦截（草稿仍在，可改后重试）。
//   draftOnly=true：只走第 1 步（保留原已真机验证过图片转存的草稿逻辑）。
//   draftOnly=false：第 1 步 + 第 2 步。
//
// 注意：tid 不是「分区」而是「封面版式」（4=单图 / 3=三图，按封面图数量定，是常量）；
//       真正的专栏分类是 category 字段，合法值来自 GET /x/article/categories（见 categories.js）。
//
// 图片上传：下载字节 → multipart POST /x/article/creative/article/upcover

export const bilibiliArticleProfile = {
    home: 'https://member.bilibili.com/platform/upload/text',
    // 确认落到创作中心域（member.bilibili.com 或 passport.bilibili.com 重定向后回来）
    originRe: '^https?://([^/]*\\.)?bilibili\\.com(/|$)',
    outputFormat: 'html',
    // 移植自 Wechatsync BilibiliAdapter.preprocessConfig
    preprocessConfig: {
        removeLinks: true,
    },
    image: {
        // B站图片上传须下载字节后 multipart POST，故用 uploadFn（多步，无法用声明式 spec）。
        // 使用 /x/article/creative/article/upcover 接口，需要 CSRF token（bili_jct cookie）。
        uploadFn: async (src, PP) => {
            // 从 cookie 取 CSRF token（页面内环境）
            var csrf = PP.cookie('bili_jct');
            if (!csrf) {
                throw new Error('未找到 bili_jct CSRF token，请确认已登录 B站');
            }
            // 下载图片字节
            var imgResp = await fetch(src, { credentials: 'omit' });
            if (!imgResp.ok) {
                throw new Error('图片下载失败（HTTP ' + imgResp.status + '）：' + src.slice(0, 120));
            }
            var blob = await imgResp.blob();
            // 构造 multipart 上传
            var fd = new FormData();
            fd.append('binary', blob, 'image.jpg');
            fd.append('csrf', csrf);
            var upResp = await fetch('https://api.bilibili.com/x/article/creative/article/upcover', {
                method: 'POST',
                credentials: 'include',
                body: fd,
            });
            var upText = await upResp.text();
            var upData = null;
            try { upData = JSON.parse(upText); } catch (e) {}
            if (!upResp.ok || !upData || upData.code !== 0 || !upData.data || !upData.data.url) {
                throw new Error('B站图片上传失败：' + (upData && upData.message ? upData.message : upText.slice(0, 150)));
            }
            return { url: upData.data.url };
        },
        // 跳过已在 B站 CDN 上的图片，不重复转存
        skip: ['hdslb.com', 'bilibili.com', 'biliimg.com'],
    },
    // 页面内发布函数：经典版专栏 API。draftOnly=true 仅建草稿；false 则建草稿后再 submit。
    // I = { title, content, draftOnly, params }，content 已完成图片转存（HTML）。
    // I.params = {
    //   category   —— 专栏分类 id（正式发布必填，由 Node 侧从 categories 接口解析校验；草稿可空）
    //   tid        —— 封面版式：4=单图 / 3=三图（默认 '4'）
    //   bannerUrl  —— 封面图 CDN url（可空；需先经 upcover 上传，由 Node 侧透传）
    //   summary    —— 摘要/digest（可空）
    //   tags       —— 标签逗号拼接字符串（可空，自由文本非闭合词表）
    //   original   —— 是否原创（布尔，默认 true）
    //   listId     —— 文集编号（默认 '0' 不加入文集）
    // }
    publish: async (I, PP) => {
        var csrf = PP.cookie('bili_jct');
        if (!csrf) {
            return { ok: false, stage: 'csrf', status: 0, message: '未找到 bili_jct CSRF token，请确认已登录 B站' };
        }
        var P = I.params || {};
        var tid = P.tid ? String(P.tid) : '4';        // 封面版式：4=单图 / 3=三图
        var listId = P.listId != null ? String(P.listId) : '0';
        var bannerUrl = P.bannerUrl ? String(P.bannerUrl) : '';
        var summary = P.summary ? String(P.summary) : '';

        // 封面图：若传了源图 URL（coverSrc）且未直接给 bannerUrl，则先经 upcover 上传拿 CDN url。
        // upcover 出处：现有 image.uploadFn + BiliExper（files={'binary':file}, post_data={'csrf'}）。
        if (!bannerUrl && P.coverSrc) {
            try {
                var covResp = await fetch(String(P.coverSrc), { credentials: 'omit' });
                if (!covResp.ok) {
                    return { ok: false, stage: 'cover', status: covResp.status, message: '封面图下载失败（HTTP ' + covResp.status + '）：' + String(P.coverSrc).slice(0, 120) };
                }
                var covBlob = await covResp.blob();
                var covFd = new FormData();
                covFd.append('binary', covBlob, 'cover.jpg');
                covFd.append('csrf', csrf);
                var upResp = await fetch('https://api.bilibili.com/x/article/creative/article/upcover', {
                    method: 'POST',
                    credentials: 'include',
                    body: covFd,
                });
                var upText = await upResp.text();
                var upData = null;
                try { upData = JSON.parse(upText); } catch (e) {}
                if (!upResp.ok || !upData || upData.code !== 0 || !upData.data || !upData.data.url) {
                    return { ok: false, stage: 'cover', status: upResp.status, message: '封面图上传失败：' + (upData && upData.message ? upData.message : upText.slice(0, 150)) };
                }
                bannerUrl = upData.data.url;
            } catch (e) {
                return { ok: false, stage: 'cover', status: 0, message: '封面图上传异常：' + String((e && e.message) || e) };
            }
        }
        var tags = P.tags ? String(P.tags) : '';
        // original 默认 true（原创）；reprint = original 的反值
        var isOriginal = P.original === false ? false : true;

        // 估算正文字数（去标签后字符数），供 submit 的 words 字段；纯展示用，非必填。
        var words = 0;
        try {
            var tmp = document.createElement('div');
            tmp.innerHTML = I.content || '';
            words = (tmp.textContent || tmp.innerText || '').replace(/\s+/g, '').length;
        } catch (e) { words = 0; }

        // ── 第 1 步：建草稿（save=0）拿 aid ──────────────────────────────────
        var draftParams = new URLSearchParams();
        draftParams.append('title', I.title);
        draftParams.append('content', I.content);
        draftParams.append('csrf', csrf);
        draftParams.append('save', '0');               // save=0 表示保存草稿
        draftParams.append('tid', tid);                // 封面版式
        if (P.category) draftParams.append('category', String(P.category));
        if (listId) draftParams.append('list_id', listId);
        if (bannerUrl) draftParams.append('banner_url', bannerUrl);
        if (summary) draftParams.append('summary', summary);
        if (tags) draftParams.append('tags', tags);
        draftParams.append('reprint', isOriginal ? '0' : '1');
        draftParams.append('original', isOriginal ? '1' : '0');
        draftParams.append('media_id', '0');
        draftParams.append('spoiler', '0');
        if (words) draftParams.append('words', String(words));

        var draftResp = await fetch('https://api.bilibili.com/x/article/creative/draft/addupdate', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://member.bilibili.com',
                'Referer': 'https://member.bilibili.com/',
            },
            body: draftParams.toString(),
        });
        var draftText = await draftResp.text();
        var draftData = null;
        try { draftData = JSON.parse(draftText); } catch (e) {}

        if (!draftResp.ok || !draftData) {
            return { ok: false, stage: 'draft', status: draftResp.status, message: draftText.slice(0, 300) };
        }
        if (draftData.code !== 0 || !draftData.data || !draftData.data.aid) {
            return { ok: false, stage: 'draft', status: draftResp.status, message: (draftData.message || '保存草稿失败') + '（code=' + draftData.code + '）' };
        }

        var aid = String(draftData.data.aid);

        // draftOnly：只建草稿，到此为止（保留原已验证逻辑）
        if (I.draftOnly) {
            var draftUrl = 'https://member.bilibili.com/platform/upload/text/edit?aid=' + aid;
            return { ok: true, draft: true, id: aid, url: draftUrl };
        }

        // 正式发布必填 category：校验传入的 id 确实是 /x/article/categories 里的合法叶子分类，
        // 找不到就报错（草稿已存），绝不 fallback 默认值。
        if (!P.category) {
            return { ok: false, stage: 'category', status: 0, message: '正式发布缺少必填的专栏分类 category（草稿 aid=' + aid + ' 已存）。请用 `bilibili categories` 取合法分类 id 后传 --category。' };
        }
        var catList = [];
        try {
            var catResp = await fetch('https://api.bilibili.com/x/article/categories', { credentials: 'include' });
            var catJson = await catResp.json();
            if (!catJson || catJson.code !== 0 || !Array.isArray(catJson.data)) {
                return { ok: false, stage: 'category', status: catResp.status, message: '获取 B站专栏分类失败，无法校验 category（草稿 aid=' + aid + ' 已存）：' + ((catJson && catJson.message) || ('code=' + (catJson && catJson.code))) };
            }
            (function walk(nodes) {
                nodes.forEach(function (n) {
                    var kids = Array.isArray(n.children) ? n.children : [];
                    catList.push({ id: String(n.id), name: n.name || '', leaf: kids.length === 0 });
                    if (kids.length) walk(kids);
                });
            })(catJson.data);
        } catch (e) {
            return { ok: false, stage: 'category', status: 0, message: '获取 B站专栏分类异常，无法校验 category（草稿 aid=' + aid + ' 已存）：' + String((e && e.message) || e) };
        }
        var catHit = catList.find(function (c) { return c.id === String(P.category); });
        if (!catHit) {
            var leafHint = catList.filter(function (c) { return c.leaf; }).map(function (c) { return c.id + '=' + c.name; }).join(' / ');
            return { ok: false, stage: 'category', status: 0, message: '专栏分类 id「' + P.category + '」不存在（草稿 aid=' + aid + ' 已存）。合法叶子分类：' + (leafHint || '（无）') };
        }
        if (!catHit.leaf) {
            return { ok: false, stage: 'category', status: 0, message: '专栏分类 id「' + P.category + '」（' + catHit.name + '）是父分类，请改用其下的叶子分类 id（草稿 aid=' + aid + ' 已存）。' };
        }

        // ── 第 2 步：正式发布 submit（带 aid）─────────────────────────────────
        // 出处 BiliExper BiliApi.py：submit body = aid/title/content/category/list_id/
        //   tid/reprint/media_id/spoiler/original/csrf。
        var submitParams = new URLSearchParams();
        submitParams.append('aid', aid);
        submitParams.append('title', I.title);
        submitParams.append('content', I.content);
        submitParams.append('category', String(P.category)); // Node 侧已校验为合法叶子分类 id
        submitParams.append('list_id', listId);
        submitParams.append('tid', tid);
        if (bannerUrl) submitParams.append('banner_url', bannerUrl);
        if (summary) submitParams.append('summary', summary);
        if (tags) submitParams.append('tags', tags);
        submitParams.append('reprint', isOriginal ? '0' : '1');
        submitParams.append('original', isOriginal ? '1' : '0');
        submitParams.append('media_id', '0');
        submitParams.append('spoiler', '0');
        if (words) submitParams.append('words', String(words));
        submitParams.append('csrf', csrf);

        var subResp = await fetch('https://api.bilibili.com/x/article/creative/article/submit', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://member.bilibili.com',
                'Referer': 'https://member.bilibili.com/',
            },
            body: submitParams.toString(),
        });
        var subText = await subResp.text();
        var subData = null;
        try { subData = JSON.parse(subText); } catch (e) {}

        if (subResp.status === 412) {
            // 风控拦截：草稿已存，可在创作中心改后重试
            return {
                ok: false,
                stage: 'submit',
                status: 412,
                message: 'B站风控拦截了发表（HTTP 412），草稿已保存（aid=' + aid + '），可在创作中心改后重试。',
            };
        }
        if (!subResp.ok || !subData) {
            return { ok: false, stage: 'submit', status: subResp.status, message: '正式发布失败：' + subText.slice(0, 300) + '（草稿 aid=' + aid + ' 已存）' };
        }
        if (subData.code !== 0) {
            return { ok: false, stage: 'submit', status: subResp.status, message: (subData.message || '正式发布失败') + '（code=' + subData.code + '，草稿 aid=' + aid + ' 已存）' };
        }

        // submit 成功返回 data.aid（通常与草稿 aid 一致）
        var pubAid = (subData.data && subData.data.aid != null) ? String(subData.data.aid) : aid;
        return { ok: true, draft: false, id: pubAid, url: 'https://www.bilibili.com/read/cv' + pubAid };
    },
};

// ── CLI 注册 ─────────────────────────────────────────────────────────────────

cli({
    site: 'bilibili',
    name: 'article',
    access: 'write',
    description: '发布 B站专栏长文（opus/article）。默认正式发布，加 --draft 仅存草稿。正文默认 Markdown，图片自动转存至 B站图床。正式发布必填 --category（合法值用 `bilibili categories` 取）。',
    domain: 'member.bilibili.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '正文（默认 Markdown；加 --html 则作 HTML 处理）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'category', help: '专栏分类 id（正式发布必填，叶子分类）。合法值用 `bilibili categories` 列举，禁止臆造。' },
        { name: 'tid', type: 'int', default: 4, help: '封面版式：4=单图 / 3=三图（按封面图数量定，默认 4）' },
        { name: 'cover', help: '封面图源 URL（可空）；会先经 upcover 上传到 B站图床再作 banner_url' },
        { name: 'banner-url', help: '封面图的 B站 CDN url（可空，已有则直接用，跳过 upcover 上传）' },
        { name: 'summary', help: '文章摘要/digest（可空）' },
        { name: 'tags', help: '标签，逗号拼接的自由文本字符串（可空，非闭合词表）' },
        { name: 'reprint', type: 'boolean', help: '标记为转载（默认原创）；加此参数则 original=0、reprint=1' },
        { name: 'list-id', type: 'int', default: 0, help: '文集编号（默认 0=不加入文集）' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿，不正式发布' },
        { name: 'execute', type: 'boolean', help: '实际提交。不加此参数时命令拒绝写入。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('B站专栏发布需要浏览器会话');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title)
            throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft);

        // 正式发布（非草稿）必填 category：Node 侧先做存在性兜底校验（具体是否为合法叶子
        // 分类由页面内 publish 再向 /x/article/categories 核验），缺失即抛 typed error，不 fallback。
        const category = typeof kwargs.category === 'string' ? kwargs.category.trim() : '';
        if (!draftOnly && !category) {
            throw new CliError('INVALID_INPUT', '正式发布 B站专栏必须指定 --category（专栏分类 id）。请先用 `bilibili categories` 列举合法分类 id；如只想存草稿请加 --draft。');
        }

        const publishParams = {
            category: category || undefined,
            tid: kwargs.tid != null ? String(kwargs.tid) : '4',
            coverSrc: typeof kwargs.cover === 'string' ? kwargs.cover.trim() : '',
            bannerUrl: typeof kwargs['banner-url'] === 'string' ? kwargs['banner-url'].trim() : '',
            summary: typeof kwargs.summary === 'string' ? kwargs.summary : '',
            tags: typeof kwargs.tags === 'string' ? kwargs.tags.trim() : '',
            original: !kwargs.reprint,
            listId: kwargs['list-id'] != null ? String(kwargs['list-id']) : '0',
        };

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: bilibiliArticleProfile,
            publishParams,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = result.draft
            ? '已保存 B站专栏草稿（需在创作中心手动发布）'
            : '已正式提交 B站专栏发表（可能进入审核态，请用 `bilibili drafts` 或访问返回 URL 回查）';
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
