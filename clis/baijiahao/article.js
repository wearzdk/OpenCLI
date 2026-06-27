import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';
import { readFile, stat } from 'node:fs/promises';

// ── 工具函数（内联，本站无 write-shared.js）──────────────────────────────────

function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此百家号写操作需要 --execute 参数才能真正发布');
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
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', `找不到文件: ${file}`); }
        if (!fileStat.isFile()) { throw new CliError('INVALID_INPUT', `--file 必须是可读文本文件: ${file}`); }
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', `文件无法读取: ${file}`); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', `文件必须是 UTF-8 编码: ${file}`); }
    }
    if (!resolved.trim()) { throw new CliError('INVALID_INPUT', '正文不能为空'); }
    return resolved;
}

function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

// ── 百家号 profile ────────────────────────────────────────────────────────────

/**
 * 百家号 profile
 *
 * 移植自 Wechatsync BaijiahaoAdapter（baijiahao.ts）。
 * - 格式：HTML（outputFormat: 'html'）
 * - preprocessConfig：Wechatsync 原适配器 preprocessConfig 仅声明了 outputFormat，
 *   无其他预处理开关，百家号编辑器对 HTML 接受度较高，不需要额外裁剪。
 * - 图片转存：下载字节 → multipart POST 上传（binary-multipart）。
 *   上传接口 /pcui/picture/uploadproxy 需要 FormData，故使用 uploadFn 实现。
 * - 发布：先从编辑页 HTML 里抓 window.__BJH__INIT__AUTH__ token，
 *   再 POST /pcui/article/save，返回 JSONP（需剥掉 `bjhdraft(...)` 包装）。
 *   Wechatsync 原始实现只保存草稿（draftOnly: true 固定），这里支持可选直接发布。
 */
export const baijiahaoProfile = {
    home: 'https://baijiahao.baidu.com',
    outputFormat: 'html',
    // Wechatsync 原适配器 preprocessConfig 只声明了 outputFormat，无其他开关。
    // 这里不添加额外的裁剪开关，保持与上游一致。
    preprocessConfig: {},

    // 图片转存：下载字节 → multipart POST。
    // 百家号图片上传需要真实 multipart 上传，不支持传 URL 让服务端自拉。
    // 跳过已在百家号/百度图床的图。
    image: {
        skip: ['baijiahao.baidu.com', 'bdstatic.com', 'bcebos.com'],
        // uploadFn：在页面内执行，下载图片字节再上传到百家号图床。
        // 移植自 Wechatsync uploadImageByUrl（去掉 this.runtime.fetch → 直接 fetch）。
        uploadFn: async (src, PP) => {
            // 1. 下载图片字节
            const imgResp = await fetch(src, { credentials: 'omit' });
            if (!imgResp.ok) {
                throw new Error('图片下载失败: ' + src + ' HTTP ' + imgResp.status);
            }
            const blob = await imgResp.blob();

            // 2. 构造表单上传
            const fd = new FormData();
            fd.append('media', blob, 'image.jpg');
            fd.append('type', 'image');
            fd.append('app_id', '1589639493090963');
            fd.append('is_waterlog', '1');
            fd.append('save_material', '1');
            fd.append('no_compress', '0');
            fd.append('is_events', '');
            fd.append('article_type', 'news');

            const uploadResp = await fetch('https://baijiahao.baidu.com/pcui/picture/uploadproxy', {
                method: 'POST',
                credentials: 'include',
                body: fd,
            });

            const res = await uploadResp.json();
            if (res.errmsg !== 'success' || !res.ret || !res.ret.https_url) {
                throw new Error(res.errmsg || '图片上传失败');
            }
            return { url: res.ret.https_url };
        },
    },

    /**
     * 页面内发布函数。
     *
     * 两条分支：
     *   - draftOnly=true  →  保存草稿：POST /pcui/article/save?callback=bjhdraft
     *       （移植自 Wechatsync BaijiahaoAdapter.publish，已真机验证图片转存）。
     *   - draftOnly=false →  正式发布：POST /pcui/article/publish?callback=bjhpublish
     *       （移植自 ai-chen2050/obsidian-wechat-public-platform bjhClient.ts L239-283 /
     *        src/api.ts L1190-L1241，两文件互证）。
     *
     * 鉴权统一：先从编辑页 HTML 抓 window.__BJH__INIT__AUTH__ token，放进 'token' 请求头。
     *
     * I = { title, content, draftOnly, params }，content 已完成预处理 + 图片转存（HTML）。
     * I.params = { cover, abstract, author }：
     *   - cover    正式发布必填的封面图 URL（外链 / data:），会在页面内上传到百家号图床拿 https_url。
     *   - abstract 摘要（可空），写入 publish 的 abstract 字段。
     *   - author   作者署名（可空）。
     */
    publish: async (I, PP) => {
        const P = I.params || {};

        // ── 第一步：从编辑页抓取 auth token ────────────────────────────────
        // 移植自 Wechatsync fetchAuthToken()，runtime.fetch → fetch。
        const editResp = await fetch('https://baijiahao.baidu.com/builder/rc/edit', {
            credentials: 'include',
        });
        const html = await editResp.text();
        const tokenMatch = html.match(/window\.__BJH__INIT__AUTH__\s*=\s*['"]([^'"]+)['"]/);
        if (!tokenMatch) {
            return { ok: false, stage: 'auth', status: editResp.status, message: '登录失效，请重新登录百家号' };
        }
        const authToken = tokenMatch[1];

        const content = I.content;

        // ── 草稿分支：save（不需要封面，保持原有已验证逻辑）────────────────
        if (I.draftOnly) {
            const params = new URLSearchParams({
                title: I.title,
                content: content,
                feed_cat: '1',
                len: String(content.length),
                activity_list: JSON.stringify([{ id: 408, is_checked: 0 }]),
                source_reprinted_allow: '0',
                original_status: '0',
                original_handler_status: '1',
                isBeautify: 'false',
                subtitle: '',
                bjhtopic_id: '',
                bjhtopic_info: '',
                type: 'news',
            });

            const saveResp = await fetch(
                'https://baijiahao.baidu.com/pcui/article/save?callback=bjhdraft',
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'token': authToken,
                    },
                    body: params,
                }
            );

            const text = await saveResp.text();
            // 剥掉 JSONP 包装：bjhdraft({...}) → {...}
            const jsonStr = text.replace(/^bjhdraft\(/, '').replace(/\)$/, '');
            let res = null;
            try { res = JSON.parse(jsonStr); } catch (e) {}

            if (!res || res.errmsg !== 'success' || !res.ret || !res.ret.article_id) {
                return {
                    ok: false,
                    stage: 'save',
                    status: saveResp.status,
                    message: (res && res.errmsg) || '保存草稿失败',
                };
            }

            const postId = String(res.ret.article_id);
            const draftUrl = 'https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=' + postId;
            return { ok: true, id: postId, url: draftUrl, draft: true };
        }

        // ── 正式发布分支：publish ─────────────────────────────────────────
        // 出处：obsidian-wechat-public-platform bjhClient.ts L217-219（缺封面抛错）+
        //       L239-283（reqBody / activity_list / postStr / POST publish / 解析 ret.url），
        //       与 src/api.ts L1190-L1241 互证。

        // 1) 封面必填：缺封面直接失败（对齐上游 'Missing banner'，绝不 fallback 默认封面）。
        if (!P.cover || !String(P.cover).trim()) {
            return { ok: false, stage: 'cover', message: '正式发布百家号文章必须提供封面图（--cover）' };
        }

        // 2) 封面上传到百家号图床，拿 https_url（复用与正文图片相同的 uploadproxy 接口）。
        let coverUrl = '';
        try {
            const imgResp = await fetch(String(P.cover), { credentials: 'omit' });
            if (!imgResp.ok) {
                return { ok: false, stage: 'cover', status: imgResp.status, message: '封面图下载失败：' + P.cover };
            }
            const blob = await imgResp.blob();
            const fd = new FormData();
            fd.append('media', blob, 'cover.jpg');
            fd.append('type', 'image');
            fd.append('app_id', '1589639493090963');
            fd.append('is_waterlog', '1');
            fd.append('save_material', '1');
            fd.append('no_compress', '0');
            fd.append('is_events', '');
            fd.append('article_type', 'news');
            const up = await fetch('https://baijiahao.baidu.com/pcui/picture/uploadproxy', {
                method: 'POST',
                credentials: 'include',
                body: fd,
            });
            const upJson = await up.json();
            if (upJson.errmsg !== 'success' || !upJson.ret || !upJson.ret.https_url) {
                return { ok: false, stage: 'cover', message: '封面图上传失败：' + (upJson.errmsg || '未知错误') };
            }
            coverUrl = upJson.ret.https_url;
        } catch (e) {
            return { ok: false, stage: 'cover', message: '封面图处理异常：' + String((e && e.message) || e) };
        }

        // 3) 上游把封面图再 append 进正文末尾（content = html + '<img src=cover><br>'）。
        const htmlWithCover = content + '<img src="' + coverUrl + '"><br>';

        // 4) 封面元数据（cropData 为上游固定占位单图）。
        const coverImages = [{
            src: coverUrl,
            cropData: { x: 0, y: 0, width: 2048, height: 1365 },
            machine_chooseimg: 0,
            isLegal: 1,
        }];
        const coverImagesMap = [{ src: coverUrl }];

        // 5) reqBody（与上游 reqBody 逐字段对齐）。
        const reqBody = {
            type: 'news',
            title: I.title,
            author: P.author ? String(P.author) : '',
            abstract: P.abstract ? String(P.abstract) : '',
            content: htmlWithCover,
            auto_mount_goods: '1',
            len: String(htmlWithCover.length),
            vertical_cover: coverUrl,
            cover_images: JSON.stringify(coverImages),
            _cover_images_map: JSON.stringify(coverImagesMap),
        };

        // 6) activity_list + postStr：上游固定常量片段，逐字搬运（已 URL 编码）。
        //    出处：src/api.ts publishToBjh 拼接的两段 query 片段。
        const activityList =
            '&activity_list%5B0%5D%5Bid%5D=408&activity_list%5B0%5D%5Bis_checked%5D=0'
            + '&activity_list%5B1%5D%5Bid%5D=ttv&activity_list%5B1%5D%5Bis_checked%5D=1'
            + '&activity_list%5B2%5D%5Bid%5D=reward&activity_list%5B2%5D%5Bis_checked%5D=1'
            + '&activity_list%5B3%5D%5Bid%5D=aigc_bjh_status&activity_list%5B3%5D%5Bis_checked%5D=0'
            + '&source_reprinted_allow=0&abstract_from=2&isBeautify=false&usingImgFilter=false&cover_layout=one';
        const postStr =
            '&source=upload&cover_source=upload&subtitle=&bjhtopic_id=&bjhtopic_info='
            + '&clue=1&bjhmt=&order_id=&aigc_rebuild='
            + '&image_edit_point=%5B%7B%22img_type%22%3A%22cover%22%2C%22img_num%22%3A%7B%22template%22%3A0%2C%22font%22%3A0%2C%22filter%22%3A0%2C%22paster%22%3A0%2C%22cut%22%3A0%2C%22any%22%3A0%7D%7D%2C%7B%22img_type%22%3A%22body%22%2C%22img_num%22%3A%7B%22template%22%3A0%2C%22font%22%3A0%2C%22filter%22%3A0%2C%22paster%22%3A0%2C%22cut%22%3A0%2C%22any%22%3A0%7D%7D%5D';

        // jsonToUrlEncoded(reqBody) + activityList + postStr（上游 body 构造方式）。
        const postBody = new URLSearchParams(reqBody).toString() + activityList + postStr;

        const pubResp = await fetch(
            'https://baijiahao.baidu.com/pcui/article/publish?callback=bjhpublish',
            {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'token': authToken,
                },
                body: postBody,
            }
        );

        const pubText = await pubResp.text();
        // 剥掉 JSONP 包装：bjhpublish({...}) → {...}
        const pubJsonStr = pubText.replace(/^bjhpublish\(/, '').replace(/\)$/, '');
        let pub = null;
        try { pub = JSON.parse(pubJsonStr); } catch (e) {}

        if (!pub || pub.errno !== 0 || !pub.ret) {
            return {
                ok: false,
                stage: 'publish',
                status: pubResp.status,
                message: (pub && (pub.errmsg || pub.errno)) || '百家号发布失败',
            };
        }

        // 成功返回 ret.url（已发布文章/媒体 URL；与 save 返回 article_id 不同）。
        const publishedUrl = pub.ret.url || '';
        return { ok: true, id: publishedUrl, url: publishedUrl, draft: false };
    },

    // 登录检测（供 whoami.js 复用）。
    // 移植自 Wechatsync checkAuth()：GET /builder/app/appinfo，判断 errmsg === 'success'。
    checkAuth: async (PP) => {
        try {
            const resp = await fetch(
                'https://baijiahao.baidu.com/builder/app/appinfo?_=' + Date.now(),
                { credentials: 'include' }
            );
            const json = await resp.json();
            if (json.errmsg === 'success' && json.data && json.data.user) {
                const u = json.data.user;
                return {
                    isAuthenticated: true,
                    userId: String(u.userid || ''),
                    username: u.name || '',
                    avatar: u.avatar || '',
                };
            }
            return { isAuthenticated: false };
        } catch (e) {
            return { isAuthenticated: false, error: String((e && e.message) || e) };
        }
    },
};

// ── CLI 注册 ────────────────────────────────────────────────────────────────

cli({
    site: 'baijiahao',
    name: 'article',
    access: 'write',
    description: '发布百家号文章。默认正式发布（需 --cover 封面），加 --draft 仅存草稿（草稿不需要封面）。正文默认 Markdown，图片自动转存到百家号图床。',
    domain: 'baijiahao.baidu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown；传 --html 则视为原始 HTML）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '将正文视为原始 HTML 而非 Markdown' },
        { name: 'cover', help: '封面图 URL（正式发布必填；会先转存到百家号图床。草稿模式可不传）' },
        { name: 'abstract', help: '文章摘要（可空，正式发布时写入；草稿模式忽略）' },
        { name: 'author', help: '作者署名（可空，正式发布时写入；草稿模式忽略）' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿，不正式发布（草稿不需要封面）' },
        { name: 'execute', type: 'boolean', help: '真正执行写操作。不加此参数时命令拒绝写入。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('百家号文章发布需要浏览器会话');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft);

        // 正式发布必须有封面：在 Node 侧先拦一道（页面内 publish 还会再校验一次），
        // 缺封面直接抛 typed error，绝不 fallback 默认封面。
        const cover = typeof kwargs.cover === 'string' ? kwargs.cover.trim() : '';
        if (!draftOnly && !cover) {
            throw new CliError('INVALID_INPUT', '正式发布百家号文章必须提供封面图：请传 --cover <图片URL>（或加 --draft 只存草稿）');
        }

        const publishParams = {
            cover,
            abstract: typeof kwargs.abstract === 'string' ? kwargs.abstract : '',
            author: typeof kwargs.author === 'string' ? kwargs.author : '',
        };

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: baijiahaoProfile,
            publishParams,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = result.draft ? '已保存百家号文章草稿' : '已正式发布百家号文章';
        if (upN || failN) {
            message += `（图片：${upN} 张已转存${failN ? `，${failN} 张失败` : ''}）`;
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
