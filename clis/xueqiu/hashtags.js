import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { xueqiuProfile } from './article.js';

// ── 雪球话题/标签（#话题#）搜索 + 热门/历史列举 ────────────────────────────────
// 雪球的「话题/标签」不是发布 body 的独立字段，而是写进正文 HTML 的 mention（输入 #
// 触发联想）。本命令供 AI 在正文里嵌入合法话题前先取得真实 id/name，禁止臆造。
//
// 三类来源（全部页面内相对路径 fetch，落在已登录的 mp.xueqiu.com 写作页 origin）：
//   - 关键词搜索：GET /statuses/tags/search.json?q=<词>&count=5
//     出处：write.6d407dcd7d.js searchMention `"#"===t&&(o="/statuses/tags/search.json",a={q:r,count:5})`
//   - 热门话题：GET /xq/query/v1/hot_event/tag.json?count=5（响应 t.data，每项 {id,title}）
//     出处：write.6d407dcd7d.js getMentionHashtagHotList `_.get("/xq/query/v1/hot_event/tag.json",{count:5})`
//     映射 `n.map(e=>({key:e.id,tag:e.title,name:e.title}))`
//   - 我最近用过：GET /xq/statuses/hashtag/recently.json?count=5（响应 t.items，每项 {id,tag}）
//     出处：write.6d407dcd7d.js getMentionHashtagHistoryList `_.get("/xq/statuses/hashtag/recently.json",{count:5})`
//     映射 `t.items.map(e=>({key:e.id,tag:e.tag,name:e.tag}))`
cli({
    site: 'xueqiu',
    name: 'hashtags',
    access: 'read',
    description: '搜索/列举雪球话题（#话题#）。带 <keyword> 时按关键词搜索；不带则列出热门 + 我最近用过的话题。供在正文里嵌入话题 mention 取合法值。',
    domain: 'mp.xueqiu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'keyword', positional: true, help: '话题关键词（不含 #）；留空则返回热门 + 历史话题' },
    ],
    columns: ['source', 'id', 'name'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('雪球话题搜索需要浏览器会话');
        await gotoWritePage(page, xueqiuProfile.home);
        const keyword = typeof kwargs.keyword === 'string' ? kwargs.keyword.trim() : '';

        const js =
            '(async () => {\n' +
            '  const kw = ' + JSON.stringify(keyword) + ';\n' +
            '  const out = [];\n' +
            '  if (kw) {\n' +
            // 关键词搜索分支：/statuses/tags/search.json?q=&count=5
            '    const r = await fetch("/statuses/tags/search.json?q=" + encodeURIComponent(kw) + "&count=5", { credentials: "include" });\n' +
            '    const t = await r.text();\n' +
            '    let j = null; try { j = JSON.parse(t); } catch (e) {}\n' +
            '    if (!r.ok || j == null) return { __err: "话题搜索失败（HTTP " + r.status + "）：" + t.slice(0, 200) };\n' +
            // 响应可能是数组，或 {tags:[...]} / {data:[...]}；逐一兜底取 id/tag/name
            '    const list = Array.isArray(j) ? j : (j.tags || j.data || j.list || []);\n' +
            '    for (const e of list) {\n' +
            '      out.push({ source: "search", id: String(e.id != null ? e.id : (e.tag_id != null ? e.tag_id : "")), name: String(e.name || e.tag || e.title || "") });\n' +
            '    }\n' +
            '    return out;\n' +
            '  }\n' +
            // 无关键词分支：热门 + 历史
            '  try {\n' +
            '    const hr = await fetch("/xq/query/v1/hot_event/tag.json?count=5", { credentials: "include" });\n' +
            '    const hj = await hr.json();\n' +
            '    if (hj && hj.data) for (const e of hj.data) out.push({ source: "hot", id: String(e.id != null ? e.id : ""), name: String(e.title || "") });\n' +
            '  } catch (e) {}\n' +
            '  try {\n' +
            '    const rr = await fetch("/xq/statuses/hashtag/recently.json?count=5", { credentials: "include" });\n' +
            '    const rj = await rr.json();\n' +
            '    if (rj && rj.items) for (const e of rj.items) out.push({ source: "recent", id: String(e.id != null ? e.id : ""), name: String(e.tag || "") });\n' +
            '  } catch (e) {}\n' +
            '  return out;\n' +
            '})()';

        const data = await page.evaluate(js);
        if (data && data.__err) throw new CliError('FETCH_ERROR', data.__err);
        return Array.isArray(data) ? data : [];
    },
});
