/**
 * 文章发布编排器（共享基础设施）
 *
 * 把「发一篇文章到任意平台」的固定套路收敛成一条流水线，平台只交一份 profile：
 *
 *   1. 归一内容       —— Markdown / HTML → 平台要的那一份（format.js）
 *   2. 导航并钉标签    —— gotoWritePage：打开写作 origin 并确认 cookie 可读（不是 data: 空白页）
 *   3. 单次 evaluate   —— 预处理 + 图片转存 + 调平台 API，全部在**同一个 page.evaluate** 里完成
 *
 * 为什么坚持「单次 evaluate」：opencli 的 page 在多次 evaluate 之间可能把活动标签漂移到
 * 会话里那个常驻的 data: 空白页（知乎曾踩：报 Cookies disabled inside data: URLs）。把
 * 预处理→转存→发布拼进一个 evaluate，从根上避免漂移，且每个平台都复用同一套页面运行时
 * （PAGE_RUNTIME：PP.preprocess / PP.transferImages，见 page-runtime.js）。
 *
 * 这正是 Wechatsync 让「AI 交一篇 Markdown 就一把发出去」的那条套路。接新平台 = 写一份
 * profile（声明 outputFormat / preprocessConfig / 图片 spec + 一个页面内 publish 函数），
 * 不重复造轮子。
 */
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { normalizeContent } from './format.js';
import { inlineLocalImages, isLocalImagePath, localImageToDataUri } from './images.js';
import { PAGE_RUNTIME } from './page-runtime.js';

/**
 * @typedef {object} PlatformProfile
 * @property {string} home  写作 origin 的导航地址，如 'https://zhuanlan.zhihu.com'
 * @property {string} [originRe]  确认已落到正确源的正则字符串；缺省从 home 的 host 推断
 * @property {'html'|'markdown'} outputFormat  正文吃 HTML 还是 Markdown
 * @property {object} [preprocessConfig]  HTML 预处理开关（见 page-runtime / Wechatsync PreprocessConfig）；仅 html 平台用
 * @property {{ spec?: object, skip?: string[], uploadFn?: Function }} [image]  图片转存声明。
 *   优先 uploadFn（页面内 `async (src, PP) => ({ url })`，用于掘金 ImageX 等多步上传）；
 *   否则用声明式 spec（form 传URL / json / binary-multipart，见 images.js / page-runtime）。
 * @property {Function} publish  页面内执行的发布函数 `async (I, PP) => ({ id, url, draft })`；
 *   I = { title, content, markdown, html, draftOnly, params }，PP = 页面运行时；
 *   只能用页面内全局（fetch/document）。I.params 为各平台发布参数（分类/标签/封面…），可空。
 */

/**
 * 选出该平台要用的那一份正文（Markdown / HTML 归一）。纯函数，便于测试。
 * @param {string} body
 * @param {PlatformProfile} profile
 * @param {'markdown'|'html'|'auto'} format
 * @returns {string}
 */
export function selectContent(body, profile, format = 'auto') {
    const norm = normalizeContent(body, { format });
    return profile.outputFormat === 'markdown' ? norm.markdown : norm.html;
}

/**
 * 由 home 推断「确认落在正确源」的正则字符串（host 转义后匹配）。
 * @param {string} home
 * @returns {string}
 */
export function originReFromHome(home) {
    let host = '';
    try { host = new URL(home).host; } catch (e) { host = ''; }
    // 允许子域：匹配 https?://(任意子域.)host
    const esc = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return '^https?://([^/]*\\.)?' + esc + '(/|$)';
}

/**
 * 导航到平台写作页并钉住标签：轮询确认页面真的落到了目标源、且 document.cookie 可读
 * （不是 data: 空白页）。这是各平台公用的「打开已登录写作页」前置，泛化自知乎 gotoZhuanlan。
 *
 * @param {{ goto: Function, wait: Function, evaluate: Function }} page
 * @param {string} home
 * @param {string} [originRe]
 */
export async function gotoWritePage(page, home, originRe) {
    const reStr = originRe || originReFromHome(home);
    for (let i = 0; i < 8; i++) {
        await page.goto(home);
        await page.wait({ time: 1 });
        const probe = await page.evaluate(`(() => {
            var href = ''; try { href = location.href; } catch (e) {}
            var onSite = new RegExp(${JSON.stringify(reStr)}).test(href);
            var cookieOk = true; try { void document.cookie; } catch (e) { cookieOk = false; }
            return { href: href, onSite: onSite, cookieOk: cookieOk };
        })()`);
        if (probe && probe.onSite && probe.cookieOk) return;
        await page.wait({ time: 1 });
    }
    throw new CommandExecutionError(
        `无法在浏览器中打开已登录的写作页（页面停留在空白页，未落到 ${home}）。`
        + '请确认登录该平台的 Chrome 已连接 opencli 浏览器桥。',
    );
}

/**
 * 拼出「预处理 + 图片转存 + 平台发布」的单次 evaluate 源码。
 * @param {object} ctx  注入页面的上下文（JSON 安全）
 * @param {string} publishFnSource  profile.publish 的源码（Function.prototype.toString）
 * @returns {string}
 */
export function buildPublishJs(ctx, publishFnSource, uploadFnSource) {
    return (
        '(async () => {\n' +
        PAGE_RUNTIME + '\n' +
        'const I = ' + JSON.stringify(ctx) + ';\n' +
        'const __publish = (' + publishFnSource + ');\n' +
        (uploadFnSource ? 'const __upload = (' + uploadFnSource + ');\n' : '') +
        'let content = I.content;\n' +
        // html 平台：先按 preprocessConfig 跑 DOM 预处理；markdown 平台：内容即 markdown，跳过。
        'if (I.outputFormat === "html" && I.preprocessConfig) content = PP.preprocess(content, I.preprocessConfig);\n' +
        // 图片转存：优先平台自定义 uploadFn（装不进声明式 spec 的平台，如掘金 ImageX）；
        // 否则走声明式 spec（form 传URL / json / binary-multipart）。
        (uploadFnSource
            ? 'const __t = await PP.processImagesWith(content, (src) => __upload(src, PP), { skip: I.imageSkip });\n'
            : 'const __t = await PP.transferImages(content, I.imageSpec, I.imageSkip);\n') +
        'content = __t.content;\n' +
        // 封面转存（统一逻辑）：publishParams.cover 与正文图走**同一条**平台图片管道——
        // 包装成单个 <img> 交给转存器（skip 域名 / data: 同一套语义），转存成功后原地
        // 替换为平台图床 URL；已在平台图床（skip 命中）则原样保留。封面是用户显式意图，
        // 转存失败必须硬失败，不允许静默丢封面发出去。
        'if (I.publishParams && typeof I.publishParams.cover === "string" && I.publishParams.cover) {\n' +
        '  var __cvWrap = \'<img src="\' + I.publishParams.cover + \'">\';\n' +
        (uploadFnSource
            ? '  var __cv = await PP.processImagesWith(__cvWrap, (src) => __upload(src, PP), { skip: I.imageSkip });\n'
            : '  var __cv = await PP.transferImages(__cvWrap, I.imageSpec, I.imageSkip);\n') +
        '  if (__cv.failed.length) {\n' +
        '    return { ok: false, stage: "cover", message: "封面图转存失败：" + __cv.failed[0].error, uploaded: __t.uploaded, failed: __t.failed.concat(__cv.failed) };\n' +
        '  }\n' +
        '  if (__cv.uploaded.length) I.publishParams.cover = __cv.uploaded[0].url;\n' +
        '  __t.uploaded = __t.uploaded.concat(__cv.uploaded);\n' +
        '}\n' +
        // 调平台发布函数（页面内，带登录态）。content 已转存；I.markdown / I.html 是未转存的
        // 两份原始格式，供需要「同时塞 markdown 和 html」的平台（如 CSDN）取用。
        'const __pub = await __publish({ title: I.title, content: content, markdown: I.markdown, html: I.html, draftOnly: I.draftOnly, params: I.publishParams }, PP);\n' +
        // 转存统计：合并「声明式转存(__t)」与「平台 publish 内部自转存(__pub)」两处，
        // 否则像语雀那种在 publish 里自己转图的平台，成功/失败数会被丢掉。
        'var __upN = (__t.uploaded || []).concat((__pub && __pub.uploaded) || []);\n' +
        'var __failN = (__t.failed || []).concat((__pub && __pub.failed) || []);\n' +
        'if (!__pub || __pub.ok === false) {\n' +
        '  return { ok: false, stage: (__pub && __pub.stage) || "publish", status: __pub && __pub.status, message: (__pub && __pub.message) || "publish failed", uploaded: __upN, failed: __failN };\n' +
        '}\n' +
        'return { ok: true, id: String(__pub.id == null ? "" : __pub.id), url: __pub.url || "", draft: !!__pub.draft, uploaded: __upN, failed: __failN };\n' +
        '})()'
    );
}

/**
 * 编排一次文章发布（单次 evaluate）。
 *
 * @param {{ goto: Function, wait: Function, evaluate: Function }} page  opencli page 句柄
 * @param {object} args
 * @param {string} args.title
 * @param {string} args.body  正文（Markdown 或 HTML）
 * @param {'markdown'|'html'|'auto'} [args.format]
 * @param {boolean} [args.draftOnly]
 * @param {PlatformProfile} args.profile
 * @param {object} [args.publishParams]  平台发布所需的额外参数（分类/标签/封面/摘要等），
 *   原样注入页面内 publish 函数的 `I.params`。各平台自行约定字段；草稿平台可忽略。
 *   发布参数必填项缺失时由各平台 publish 抛错，**不做 fallback 默认值**。
 * @returns {Promise<{ id: string, url: string, draft: boolean, images: { uploaded: Array, failed: Array } }>}
 */
export async function publishArticle(page, args) {
    const { title, body, format = 'auto', draftOnly = false, profile, publishParams = null } = args;
    if (!profile) throw new Error('publishArticle: profile is required');
    if (!profile.home) throw new Error('publishArticle: profile.home is required');
    if (typeof profile.publish !== 'function') throw new Error('publishArticle: profile.publish must be a function');

    const norm = normalizeContent(body, { format });

    // Node 侧：正文里引用的【本机图片路径】页面内 fetch 不到（会被当成站点相对 URL → 404），
    // 先读成 data: URI 再注入页面，交给平台的图片转存把它上传到平台图床。
    const mdInlined = await inlineLocalImages(norm.markdown);
    const htmlInlined = await inlineLocalImages(norm.html);
    const markdown = mdInlined.content;
    const html = htmlInlined.content;
    const content = profile.outputFormat === 'markdown' ? markdown : html;
    // 合并两份的「本机图片读取失败」（按 src 去重），供命令层据此把结果判为 partial。
    const localMissing = [];
    const seenMissing = new Set();
    for (const m of [...mdInlined.missing, ...htmlInlined.missing]) {
        if (seenMissing.has(m.src)) continue;
        seenMissing.add(m.src);
        localMissing.push(m);
    }

    // 封面（publishParams.cover）：本机路径页面内 fetch 不到，与正文图同理先读成 data: URI，
    // 交给页面内的统一封面转存（见 buildPublishJs）。读取失败硬报错——封面是显式意图。
    let effectiveParams = publishParams;
    if (effectiveParams && typeof effectiveParams.cover === 'string' && effectiveParams.cover) {
        const cover = effectiveParams.cover.trim();
        if (/["<>\s]/.test(cover)) {
            throw new CommandExecutionError('封面图路径/URL 含非法字符（引号/尖括号/空白）：' + cover.slice(0, 120));
        }
        if (isLocalImagePath(cover)) {
            try {
                const { dataUri } = await localImageToDataUri(cover);
                effectiveParams = { ...effectiveParams, cover: dataUri };
            } catch (e) {
                throw new CommandExecutionError('封面图读取失败：' + cover + '（' + String((e && e.message) || e) + '）');
            }
        } else {
            effectiveParams = { ...effectiveParams, cover };
        }
    }

    await gotoWritePage(page, profile.home, profile.originRe);

    const ctx = {
        title,
        content,
        markdown,
        html,
        draftOnly: !!draftOnly,
        outputFormat: profile.outputFormat,
        preprocessConfig: profile.preprocessConfig || null,
        imageSpec: profile.image?.spec || null,
        imageSkip: profile.image?.skip || [],
        publishParams: effectiveParams,
    };
    const uploadFnSource = typeof profile.image?.uploadFn === 'function' ? profile.image.uploadFn.toString() : null;
    const js = buildPublishJs(ctx, profile.publish.toString(), uploadFnSource);
    const result = await page.evaluate(js);

    if (!result || result.ok === false) {
        const stage = result?.stage || 'publish';
        const status = result?.status != null ? ` (HTTP ${result.status})` : '';
        throw new CommandExecutionError(`[${stage}] ${result?.message || '发布失败'}${status}`);
    }
    return {
        id: result.id,
        url: result.url,
        draft: result.draft,
        // 图片失败 = 页面内转存失败(result.failed) + Node 侧本机图片读取失败(localMissing)。
        images: {
            uploaded: result.uploaded || [],
            failed: (result.failed || []).concat(localMissing),
        },
    };
}

export const __test__ = {
    selectContent,
    originReFromHome,
    buildPublishJs,
    publishArticle,
};
