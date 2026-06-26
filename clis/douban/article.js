// @ts-check
import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { publishArticle } from '../_shared/article/publish.js';
import { readFile, stat } from 'node:fs/promises';

// ── 辅助：requireExecute / resolvePayload / buildResultRow（内联，豆瓣无 write-shared.js）──

/**
 * 若未传 --execute，拒绝写操作。
 * @param {Record<string,unknown>} kwargs
 */
function requireExecute(kwargs) {
    if (!kwargs.execute) {
        throw new CliError('INVALID_INPUT', '此命令需要 --execute 才会真正发布，去掉 --execute 不会写入任何数据。');
    }
}

/**
 * 从 kwargs 取正文（text 参数 或 --file 文件）。
 * @param {Record<string,unknown>} kwargs
 * @returns {Promise<string>}
 */
async function resolvePayload(kwargs) {
    const text = typeof kwargs.text === 'string' ? kwargs.text : undefined;
    const file = typeof kwargs.file === 'string' ? kwargs.file : undefined;
    if (text && file) throw new CliError('INVALID_INPUT', 'text 和 --file 不能同时使用');
    let resolved = text ?? '';
    if (file) {
        let fileStat;
        try { fileStat = await stat(file); } catch { throw new CliError('INVALID_INPUT', `文件未找到：${file}`); }
        if (!fileStat.isFile()) throw new CliError('INVALID_INPUT', `必须是可读文本文件：${file}`);
        let raw;
        try { raw = await readFile(file); } catch { throw new CliError('INVALID_INPUT', `文件无法读取：${file}`); }
        try { resolved = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new CliError('INVALID_INPUT', `文件不是合法 UTF-8 文本：${file}`); }
    }
    if (!resolved.trim()) throw new CliError('INVALID_INPUT', '正文不能为空');
    return resolved;
}

/**
 * 组装结果行（遵循 opencli 列表返回格式）。
 * @param {string} message
 * @param {string} targetType
 * @param {string} target
 * @param {string} outcome
 * @param {Record<string,unknown>} [extra]
 * @returns {Array<Record<string,unknown>>}
 */
function buildResultRow(message, targetType, target, outcome, extra = {}) {
    return [{ status: 'success', outcome, message, target_type: targetType, target, ...extra }];
}

// ── 豆瓣 profile ────────────────────────────────────────────────────────────────

/**
 * 豆瓣日记（note）发布 profile。
 *
 * 豆瓣特殊流程：
 * 1. 打开 /note/create 页面，解析 note_id / ck / upload_auth_token（_POST_PARAMS.siteCookie.value）。
 * 2. 图片通过 /j/note/add_photo 上传（multipart），返回完整 photo 对象（含 id/thumb 等）。
 * 3. 正文发布到 /j/note/autosave，note_text 字段是 Draft.js JSON 字符串（豆瓣富文本格式）。
 *
 * outputFormat='markdown'：正文直接作为 Markdown 传入，不走 HTML 预处理；图片转存后
 * 在 publish 函数里把 Markdown + photo 元数据一起转换成 Draft.js JSON。
 *
 * 参考来源：Wechatsync v2 packages/core/src/adapters/platforms/douban.ts
 */
const doubanProfile = {
    home: 'https://www.douban.com/note/create',
    // 允许落到 www.douban.com 及子域
    originRe: '^https?://([^/]*\\.)?douban\\.com(/|$)',
    outputFormat: 'markdown',
    // markdown 平台无需 preprocessConfig

    // 图片转存：自定义 uploadFn（多步：先解析页面取凭证，再上传）。
    // uploadFn 里维护页面级全局 __doubanPhotoMap，把 photo 完整数据按新 URL 存起来，
    // 供 publish 函数构造 Draft.js entityMap。
    image: {
        skip: ['doubanio.com', 'douban.com'],
        uploadFn: async (src, PP) => {
            // 初始化全局 photo map（跨多次调用共享，同一 evaluate 作用域有效）。
            if (!globalThis.__doubanPhotoMap) globalThis.__doubanPhotoMap = {};

            // 第一次上传时从当前页面解析表单参数（checkAuth 已确认在 /note/create）。
            if (!globalThis.__doubanFormData) {
                const html = document.documentElement.innerHTML;
                const noteIdM = html.match(/name="note_id"\s+value="(\d+)"/);
                const ckM = html.match(/name="ck"\s+value="([^"]+)"/);
                const postParamsM = html.match(/_POST_PARAMS\s*=\s*(\{[\s\S]*?\});/);
                if (!noteIdM || !ckM) throw new Error('豆瓣：无法从页面解析 note_id / ck，请确认已登录');
                let uploadAuthToken = '';
                if (postParamsM) {
                    const scM = postParamsM[1].match(/siteCookie[^}]*value\s*:\s*['"]([^'"]+)['"]/);
                    if (scM) uploadAuthToken = scM[1];
                }
                globalThis.__doubanFormData = { note_id: noteIdM[1], ck: ckM[1], uploadAuthToken };
            }

            const fd = globalThis.__doubanFormData;

            // 下载图片字节。
            const imgResp = await fetch(src, { credentials: 'omit' });
            if (!imgResp.ok) throw new Error('图片下载失败：' + src);
            const blob = await imgResp.blob();

            // 上传到豆瓣图床。
            // upload_auth_token 是豆瓣上传必需凭证（忠实 Wechatsync：缺则抛「未获取上传凭证」），
            // 不能静默跳过，否则服务端拒绝、图片全裂还以为成功了。
            if (!fd.uploadAuthToken) throw new Error('豆瓣：未获取上传凭证 upload_auth_token');
            const form = new FormData();
            form.append('note_id', fd.note_id);
            form.append('image_file', blob, 'image.jpg');
            form.append('ck', fd.ck);
            form.append('upload_auth_token', fd.uploadAuthToken);

            const upResp = await fetch('https://www.douban.com/j/note/add_photo', {
                method: 'POST',
                credentials: 'include',
                body: form,
            });
            if (!upResp.ok) throw new Error('豆瓣图片上传 HTTP ' + upResp.status);
            const res = await upResp.json();
            if (!res.photo || !res.photo.url) throw new Error('豆瓣图片上传：无 photo.url，响应：' + JSON.stringify(res).slice(0, 200));

            const photo = res.photo;
            // 把完整 photo 数据存入全局 map，以新 URL 为键，供 publish 函数取用。
            globalThis.__doubanPhotoMap[photo.url] = photo;

            return { url: photo.url };
        },
    },

    // 页面内发布函数：把 Markdown 转为 Draft.js JSON，再调 autosave API。
    // I = { title, content（已转存图片的 Markdown）, draftOnly }
    // PP = 页面运行时（此处仅用 PP.cookie）
    publish: async (I, PP) => {
        // 取表单参数（uploadFn 阶段已解析好）。
        const fd = globalThis.__doubanFormData;
        if (!fd) {
            // 若没有图片上传，uploadFn 未被调用，这里补一次解析。
            const html = document.documentElement.innerHTML;
            const noteIdM = html.match(/name="note_id"\s+value="(\d+)"/);
            const ckM = html.match(/name="ck"\s+value="([^"]+)"/);
            if (!noteIdM || !ckM) {
                return { ok: false, stage: 'parse', message: '豆瓣：无法从页面解析 note_id / ck，请确认已登录并在 /note/create 页面' };
            }
            globalThis.__doubanFormData = { note_id: noteIdM[1], ck: ckM[1], uploadAuthToken: '' };
        }
        const formData = globalThis.__doubanFormData;
        const photoMap = globalThis.__doubanPhotoMap || {};

        // ── Markdown → Draft.js JSON（简化实现，覆盖豆瓣常用格式）─────────────────
        // 豆瓣 note_text 是 Draft.js ContentState 的 JSON 序列化。
        // Draft.js 结构：{ blocks: [...], entityMap: {...} }
        // block 类型：unstyled（段落）/ header-two / header-three / unordered-list-item / ordered-list-item / atomic（图片）/ code-block
        // 图片 block：type='atomic', text=' ', entityRanges=[{offset:0,length:1,key}], entityMap[key]={type:'IMAGE',mutability:'IMMUTABLE',data:{id,src,thumb,url,...}}

        var entityMap = {};
        var entityKey = 0;

        function escapeText(t) { return String(t || ''); }

        function makeBlock(type, text, inlineStyleRanges, entityRanges) {
            return {
                key: String(entityKey++),
                type: type,
                text: text,
                depth: 0,
                inlineStyleRanges: inlineStyleRanges || [],
                entityRanges: entityRanges || [],
                data: {},
            };
        }

        // 处理行内格式（**bold**、*italic*、`code`），返回 { text, inlineStyleRanges }
        function parseInline(raw) {
            var text = '';
            var styles = [];
            var pos = 0;
            var i = 0;
            var src = raw;
            // 逐字符处理
            while (i < src.length) {
                // **bold** 或 __bold__
                if ((src[i] === '*' && src[i + 1] === '*') || (src[i] === '_' && src[i + 1] === '_')) {
                    var delim = src.slice(i, i + 2);
                    var end = src.indexOf(delim, i + 2);
                    if (end !== -1) {
                        var inner = src.slice(i + 2, end);
                        var start = text.length;
                        text += inner;
                        styles.push({ offset: start, length: inner.length, style: 'BOLD' });
                        i = end + 2;
                        continue;
                    }
                }
                // *italic* 或 _italic_
                if ((src[i] === '*' || src[i] === '_') && src[i + 1] !== src[i]) {
                    var ch = src[i];
                    var end2 = src.indexOf(ch, i + 1);
                    if (end2 !== -1 && end2 > i + 1) {
                        var inner2 = src.slice(i + 1, end2);
                        var start2 = text.length;
                        text += inner2;
                        styles.push({ offset: start2, length: inner2.length, style: 'ITALIC' });
                        i = end2 + 1;
                        continue;
                    }
                }
                // `code`
                if (src[i] === '`') {
                    var end3 = src.indexOf('`', i + 1);
                    if (end3 !== -1) {
                        var inner3 = src.slice(i + 1, end3);
                        var start3 = text.length;
                        text += inner3;
                        styles.push({ offset: start3, length: inner3.length, style: 'CODE' });
                        i = end3 + 1;
                        continue;
                    }
                }
                // 链接 [text](url) → 只保留文字
                if (src[i] === '[') {
                    var closeBracket = src.indexOf('](', i + 1);
                    if (closeBracket !== -1) {
                        var closeParen = src.indexOf(')', closeBracket + 2);
                        if (closeParen !== -1) {
                            var linkText = src.slice(i + 1, closeBracket);
                            text += linkText;
                            i = closeParen + 1;
                            continue;
                        }
                    }
                }
                text += src[i];
                i++;
            }
            return { text: text, inlineStyleRanges: styles };
        }

        var blocks = [];
        var lines = I.content.split('\n');
        var li = 0;
        while (li < lines.length) {
            var line = lines[li];

            // 图片行：![alt](url)
            var imgM = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
            if (imgM) {
                var imgUrl = imgM[2].trim();
                var photo = photoMap[imgUrl];
                var k = entityKey++;
                if (photo) {
                    entityMap[k] = {
                        type: 'IMAGE',
                        mutability: 'IMMUTABLE',
                        data: {
                            id: photo.id,
                            src: photo.url,
                            thumb: photo.thumb,
                            url: photo.url,
                            width: photo.width || 0,
                            height: photo.height || 0,
                            file_name: photo.file_name || '',
                            file_size: photo.file_size || 0,
                        },
                    };
                } else {
                    entityMap[k] = {
                        type: 'IMAGE',
                        mutability: 'IMMUTABLE',
                        data: { id: '', src: imgUrl, thumb: imgUrl, url: imgUrl },
                    };
                }
                blocks.push({
                    key: String(entityKey++),
                    type: 'atomic',
                    text: ' ',
                    depth: 0,
                    inlineStyleRanges: [],
                    entityRanges: [{ offset: 0, length: 1, key: k }],
                    data: {},
                });
                li++;
                continue;
            }

            // 代码块 ```...```
            if (line.match(/^```/)) {
                var codeLines = [];
                li++;
                while (li < lines.length && !lines[li].match(/^```/)) {
                    codeLines.push(lines[li]);
                    li++;
                }
                li++; // 跳过结尾 ```
                var codeText = codeLines.join('\n');
                blocks.push(makeBlock('code-block', codeText, [], []));
                continue;
            }

            // 标题
            var hM = line.match(/^(#{1,6})\s+(.+)/);
            if (hM) {
                var level = hM[1].length;
                var hType = level <= 2 ? 'header-two' : 'header-three';
                var parsed = parseInline(hM[2]);
                blocks.push(makeBlock(hType, parsed.text, parsed.inlineStyleRanges, []));
                li++;
                continue;
            }

            // 无序列表
            var ulM = line.match(/^[\*\-\+]\s+(.+)/);
            if (ulM) {
                var parsed2 = parseInline(ulM[1]);
                blocks.push(makeBlock('unordered-list-item', parsed2.text, parsed2.inlineStyleRanges, []));
                li++;
                continue;
            }

            // 有序列表
            var olM = line.match(/^\d+\.\s+(.+)/);
            if (olM) {
                var parsed3 = parseInline(olM[1]);
                blocks.push(makeBlock('ordered-list-item', parsed3.text, parsed3.inlineStyleRanges, []));
                li++;
                continue;
            }

            // 水平线 → 空段落
            if (line.match(/^---+$/) || line.match(/^\*\*\*+$/)) {
                blocks.push(makeBlock('unstyled', '', [], []));
                li++;
                continue;
            }

            // 引用块（> ）
            var bqM = line.match(/^>\s*(.*)/);
            if (bqM) {
                var parsed4 = parseInline(bqM[1]);
                blocks.push(makeBlock('blockquote', parsed4.text, parsed4.inlineStyleRanges, []));
                li++;
                continue;
            }

            // 空行 → unstyled 空段落
            if (!line.trim()) {
                blocks.push(makeBlock('unstyled', '', [], []));
                li++;
                continue;
            }

            // 普通段落
            var parsed5 = parseInline(line);
            blocks.push(makeBlock('unstyled', parsed5.text, parsed5.inlineStyleRanges, []));
            li++;
        }

        // 确保至少有一个块
        if (blocks.length === 0) {
            blocks.push(makeBlock('unstyled', '', [], []));
        }

        var draftContent = JSON.stringify({ blocks: blocks, entityMap: entityMap });

        // ── 调 autosave API 保存草稿 / 发布 ──────────────────────────────────────
        // 豆瓣日记 API 只有「保存（草稿）」，没有独立的「发布」接口；
        // note_privacy='P' 表示公开，draftOnly 时也直接保存（豆瓣草稿只在 /note/create 可见）。
        const saveResp = await fetch('https://www.douban.com/j/note/autosave', {
            method: 'POST',
            credentials: 'include',
            // 不手写 Origin/Referer：页面内同源 fetch 由浏览器自动带对（JS 设这两个 header 本就被忽略），
            // 这是 in-page 模型替代 Wechatsync header 规则的地方。
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                is_rich: '1',
                note_id: formData.note_id,
                note_title: I.title,
                note_text: draftContent,
                introduction: '',
                note_privacy: 'P',
                cannot_reply: '',
                author_tags: '',
                accept_donation: '',
                donation_notice: '',
                is_original: '',
                ck: formData.ck,
            }),
        });

        const saveText = await saveResp.text();
        var saveData = null;
        try { saveData = JSON.parse(saveText); } catch (e) {}

        if (!saveResp.ok) {
            return { ok: false, stage: 'save', status: saveResp.status, message: saveText.slice(0, 300) };
        }

        // 豆瓣 autosave 成功响应：{ r: 0, url: 'https://www.douban.com/note/<note_id>/' }
        var noteId = formData.note_id;
        var noteUrl = (saveData && saveData.url) || ('https://www.douban.com/note/' + noteId + '/');

        // 清理本次 evaluate 的全局缓存（避免泄漏到下次）
        globalThis.__doubanFormData = null;
        globalThis.__doubanPhotoMap = null;

        return { ok: true, id: noteId, url: noteUrl, draft: !!I.draftOnly };
    },
};

// ── CLI 注册 ─────────────────────────────────────────────────────────────────────

cli({
    site: 'douban',
    name: 'article',
    access: 'write',
    description: '发布豆瓣日记。正文默认 Markdown，图片自动转存到豆瓣图床，note_text 以 Draft.js 格式提交。',
    domain: 'www.douban.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: '日记标题' },
        { name: 'text', positional: true, help: '正文（Markdown 格式；也可用 --file）' },
        { name: 'file', help: '正文文件路径（UTF-8，Markdown 格式）' },
        { name: 'html', type: 'boolean', help: '把正文当 HTML 处理而不是 Markdown' },
        { name: 'draft', type: 'boolean', help: '仅保存草稿，不公开发布（豆瓣日记草稿等同于 autosave）' },
        { name: 'execute', type: 'boolean', help: '真正执行写操作；不带此参数命令会拒绝写入' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('豆瓣 article 命令需要浏览器会话（Browser session required）');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title) throw new CliError('INVALID_INPUT', '文章标题不能为空');
        const body = await resolvePayload(kwargs);
        const draftOnly = Boolean(kwargs.draft);

        const result = await publishArticle(page, {
            title,
            body,
            format: kwargs.html ? 'html' : 'markdown',
            draftOnly,
            profile: doubanProfile,
        });

        const upN = result.images.uploaded.length | 0;
        const failN = result.images.failed.length | 0;
        let message = draftOnly ? '已保存豆瓣日记草稿' : '已发布豆瓣日记';
        if (upN || failN) {
            message += `・图片：${upN} 张已转存${failN ? `，${failN} 张失败` : ''}`;
        }
        return buildResultRow(
            message,
            'article',
            '',
            draftOnly ? 'draft' : 'created',
            { created_target: 'note:' + result.id, created_url: result.url },
        );
    },
});
