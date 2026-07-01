// @ts-check
import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';
import { readFile, stat } from 'node:fs/promises';

// ── 取正文工具（与 zhihu/write-shared.js 等价的精简版）─────────────────────────
function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '微信公众号写操作需要 --execute 确认，避免误发。');
    }
}

async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) {
        throw new CliError('INVALID_INPUT', '请只提供 <text> 或 --file 中的一种，不能同时使用。');
    }
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', `文件不存在：${file}`); }
        if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', `路径不是可读文本文件：${file}`);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', `文件无法读取：${file}`); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', `文件无法解码为 UTF-8：${file}`); }
    }
    if (!resolved.trim()) throw new CliError('INVALID_INPUT', '正文不能为空。');
    return resolved;
}

function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

// ── 微信公众号 profile ──────────────────────────────────────────────────────────
//
// 说明：
//   - 发布走 Wechatsync 的 operate_appmsg API 路线（JSON/form 参数），与现有
//     create-draft.js（ProseMirror UI 路线）互补。
//     · article.js  → AI 自动化发文（无需手动操作编辑器，适合纯文字/带远程图）
//     · create-draft.js → 带本地封面图、需要精细排版的交互式场景
//   - 图片转存：下载字节 → multipart 上传到微信 CDN（需从页面解析 token/ticket）。
//     因为需要先从页面 HTML 拿鉴权参数再上传，用 uploadFn（不适合声明式 spec）。
//   - 移植自 Wechatsync WeixinAdapter（packages/core/src/adapters/platforms/weixin.ts）。
// ───────────────────────────────────────────────────────────────────────────────

export const weixinProfile = {
    // 写作/草稿 API 都在这个域，登录态也在这里
    home: 'https://mp.weixin.qq.com',

    // 微信公众号只吃 HTML，MD 先由 format.js 转换
    outputFormat: 'html',

    // 预处理开关：移植自 Wechatsync WeixinAdapter.preprocessConfig
    // 移除外链（微信不允许非 mp.weixin.qq.com 域名链接）；压缩标签间空白避免 ProseMirror 空节点
    preprocessConfig: {
        removeLinks: true,
        keepLinkDomains: ['mp.weixin.qq.com', 'weixin.qq.com'],
        compactHtml: true,
    },

    // 图片转存：多步（下载字节 → multipart），且需要从页面实时读取 token/ticket/svrTime
    // 用 uploadFn（页面内函数）实现
    image: {
        skip: ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn'],
        uploadFn: async (src, PP) => {
            // 从页面 HTML 解析微信元数据（每次调用均从当前页面实时读取）
            const html = document.documentElement.innerHTML;
            const tokenMatch = html.match(/data:\s*\{[\s\S]*?t:\s*["']([^"']+)["']/);
            const ticketMatch = html.match(/ticket:\s*["']([^"']+)["']/);
            const userNameMatch = html.match(/user_name:\s*["']([^"']+)["']/);
            const timeMatch = html.match(/time:\s*["'](\d+)["']/);

            if (!tokenMatch) {
                throw new Error('微信图片上传：页面中未找到 token，请确认已登录 mp.weixin.qq.com。');
            }

            const token = tokenMatch[1];
            const ticket = ticketMatch ? ticketMatch[1] : '';
            const userName = userNameMatch ? userNameMatch[1] : '';
            const svrTime = timeMatch ? Number(timeMatch[1]) : Math.floor(Date.now() / 1000);

            // 下载图片字节
            const imgResp = await fetch(src, { credentials: 'omit' });
            if (!imgResp.ok) throw new Error('图片下载失败：' + src + '（HTTP ' + imgResp.status + '）');
            const blob = await imgResp.blob();

            // 组装 multipart 表单（与 Wechatsync uploadImageByUrl 字段一致）
            const timestamp = Date.now();
            const fileName = timestamp + '.jpg';
            const fd = new FormData();
            fd.append('type', blob.type || 'image/jpeg');
            fd.append('id', String(timestamp));
            fd.append('name', fileName);
            fd.append('lastModifiedDate', new Date().toString());
            fd.append('size', String(blob.size));
            fd.append('file', blob, fileName);

            const seq = Date.now();
            const uploadUrl =
                'https://mp.weixin.qq.com/cgi-bin/filetransfer' +
                '?action=upload_material&f=json&scene=8&writetype=doublewrite&groupid=1' +
                '&ticket_id=' + encodeURIComponent(userName) +
                '&ticket=' + encodeURIComponent(ticket) +
                '&svr_time=' + svrTime +
                '&token=' + encodeURIComponent(token) +
                '&lang=zh_CN&seq=' + seq + '&t=' + Math.random();

            const upResp = await fetch(uploadUrl, { method: 'POST', credentials: 'include', body: fd });
            const upJson = await upResp.json().catch(() => ({}));

            if (!upResp.ok || upJson.base_resp?.err_msg !== 'ok' || !upJson.cdn_url) {
                throw new Error(
                    '微信图片上传失败：' + src +
                    '（' + (upJson.base_resp?.err_msg || ('HTTP ' + upResp.status)) + '）',
                );
            }

            return { url: upJson.cdn_url };
        },
    },

    // 登录检测：移植自 Wechatsync WeixinAdapter.checkAuth()
    // 在 mp.weixin.qq.com 首页解析账号标识 / nickName / avatar
    checkAuth: async (_PP) => {
        const resp = await fetch('https://mp.weixin.qq.com/', { method: 'GET', credentials: 'include' });
        const html = await resp.text();

        // 判据用账号标识 user_name（gh_xxx），不能用 token——实测未登录首页里
        // `data:{ ... t:"https://res.wx.qq.com/mpres/..." }` 会误命中 token 正则，
        // 导致把登录页当成已登录。user_name / nick_name 只在已登录的公众平台首页出现。
        const userNameMatch = html.match(/user_name:\s*["']([^"']+)["']/);
        const nickNameMatch = html.match(/nick_name:\s*["']([^"']+)["']/);
        if (!userNameMatch && !nickNameMatch) {
            return { isAuthenticated: false };
        }

        const avatarMatch = html.match(/class="weui-desktop-account__thumb"[^>]*src="([^"]+)"/);
        const headImgMatch = html.match(/head_img:\s*['"]([^'"]+)['"]/);

        let avatar = avatarMatch ? avatarMatch[1] : (headImgMatch ? headImgMatch[1] : '');
        if (avatar.startsWith('http://')) avatar = avatar.replace('http://', 'https://');

        return {
            isAuthenticated: true,
            userId: userNameMatch ? userNameMatch[1] : '',
            username: nickNameMatch ? nickNameMatch[1] : '',
            avatar,
        };
    },

    // 发布函数（页面内执行）：移植自 Wechatsync WeixinAdapter.publish()
    // 从页面 HTML 读 token → 调 operate_appmsg API 创建/更新草稿
    // I = { title, content, draftOnly }，content 已完成预处理 + 图片转存
    publish: async (I, _PP) => {
        const html = document.documentElement.innerHTML;
        const tokenMatch = html.match(/data:\s*\{[\s\S]*?t:\s*["']([^"']+)["']/);
        if (!tokenMatch) {
            return { ok: false, stage: 'auth', message: '页面中未找到 token，请确认已登录 mp.weixin.qq.com。' };
        }
        const token = tokenMatch[1];

        // 微信的 CSS 内联处理（简化版，不依赖 juice 库）
        // Wechatsync 用 juice.inlineContent 做内联样式；此处保持 HTML 原样，
        // 微信编辑器接受普通 HTML，样式可选（正文字体/行高由微信端渲染）。
        const content = I.content;

        const params = new URLSearchParams({
            token: token,
            lang: 'zh_CN',
            f: 'json',
            ajax: '1',
            random: String(Math.random()),
            AppMsgId: '',
            count: '1',
            data_seq: '0',
            operate_from: 'Chrome',
            isnew: '0',
            ad_video_transition0: '',
            can_reward0: '0',
            related_video0: '',
            is_video_recommend0: '-1',
            title0: I.title,
            author0: '',
            writerid0: '0',
            fileid0: '',
            digest0: '',
            auto_gen_digest0: '1',
            content0: content,
            sourceurl0: '',
            need_open_comment0: '1',
            only_fans_can_comment0: '0',
            cdn_url0: '',
            cdn_235_1_url0: '',
            cdn_1_1_url0: '',
            cdn_url_back0: '',
            crop_list0: '',
            music_id0: '',
            video_id0: '',
            voteid0: '',
            voteismlt0: '',
            supervoteid0: '',
            cardid0: '',
            cardquantity0: '',
            cardlimit0: '',
            vid_type0: '',
            show_cover_pic0: '0',
            shortvideofileid0: '',
            copyright_type0: '0',
            releasefirst0: '',
            platform0: '',
            reprint_permit_type0: '',
            allow_reprint0: '',
            allow_reprint_modify0: '',
            original_article_type0: '',
            ori_white_list0: '',
            free_content0: '',
            fee0: '0',
            ad_id0: '',
            guide_words0: '',
            is_share_copyright0: '0',
            share_copyright_url0: '',
            source_article_type0: '',
            reprint_recommend_title0: '',
            reprint_recommend_content0: '',
            share_page_type0: '0',
            share_imageinfo0: '{"list":[]}',
            share_video_id0: '',
            dot0: '{}',
            share_voice_id0: '',
            insert_ad_mode0: '',
            categories_list0: '[]',
        });

        const resp = await fetch(
            'https://mp.weixin.qq.com/cgi-bin/operate_appmsg?t=ajax-response&sub=create&type=77' +
            '&token=' + encodeURIComponent(token) + '&lang=zh_CN',
            {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params,
            },
        );

        var resText = await resp.text();
        var res = null;
        try { res = JSON.parse(resText); } catch (e) {}

        if (!resp.ok || !res || !res.appMsgId) {
            // 根据 Wechatsync formatError 映射常见错误码
            var ret = res && (res.ret != null ? res.ret : (res.base_resp && res.base_resp.ret));
            var errMap = {
                '-6': '请输入验证码', '-8': '请输入验证码',
                '-1': '系统错误，请注意备份内容后重试',
                '-2': '参数错误，请注意备份内容后重试',
                '-99': '内容超出字数，请调整',
                '200003': '登录态超时，请重新登录',
                '64507': '内容不能包含外部链接',
                '64702': '标题超出 64 字长度限制',
                '64705': '内容超出字数，请调整',
            };
            var errMsg = (ret != null && errMap[String(ret)]) || ('发布失败（错误码：' + ret + '）：' + resText.slice(0, 200));
            return { ok: false, stage: 'publish', status: resp.status, message: errMsg };
        }

        const draftUrl =
            'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77' +
            '&appmsgid=' + res.appMsgId + '&token=' + encodeURIComponent(token) + '&lang=zh_CN';

        return { ok: true, id: String(res.appMsgId), url: draftUrl, draft: true };
    },
};

// ── whoami 认证 profile（供 whoami.js 复用）──────────────────────────────────
export const weixinAuthProfile = {
    home: weixinProfile.home,
    checkAuth: weixinProfile.checkAuth,
};

// ── CLI 注册 ──────────────────────────────────────────────────────────────────
cli({
    site: 'weixin',
    name: 'article',
    access: 'write',
    description: '通过 API 把文章发布到微信公众号草稿箱。正文默认 Markdown，外链图片自动转存到微信 CDN。',
    domain: 'mp.weixin.qq.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '文章标题（最长 64 字）' },
        { name: 'text', positional: true, help: '文章正文（默认 Markdown；加 --html 则当 HTML 处理）' },
        { name: 'file', help: '正文文件路径（UTF-8，默认 Markdown）' },
        { name: 'html', type: 'boolean', help: '把正文当 HTML 处理而不是 Markdown' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿（微信公众号目前只支持草稿，此参数保留兼容性）' },
        { name: 'execute', type: 'boolean', help: '实际执行发布。不加此参数时命令拒绝写入。' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('微信公众号 article 命令需要浏览器会话。');
        requireExecute(kwargs);

        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空。');

        const body = await resolvePayload(kwargs);
        const draftOnly = true; // 微信 operate_appmsg 本质上只创建草稿，发布需在后台手动操作

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: weixinProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = '已保存微信公众号草稿';
        if (upN || failN) {
            message += '·图片：' + upN + ' 张已转存' + (failN ? '，' + failN + ' 张失败' : '');
        }

        return buildResultRow(
            message,
            'article',
            '',
            'draft',
            { created_target: 'article:' + result.id, created_url: result.url },
        );
    },
});
