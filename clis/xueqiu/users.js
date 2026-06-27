import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { xueqiuProfile } from './article.js';

// ── 雪球用户（@某人）联想搜索 ──────────────────────────────────────────────────
// @用户不是发布 body 字段，而是写进正文 HTML 的 mention（输入 @ 触发联想）。
// 本命令供 AI 在正文里 @某人前取得真实用户 id，禁止臆造。
// 接口：GET /xq/query/v1/old/search/user.json?q=<关键词>&count=5
// 出处：write.6d407dcd7d.js searchMention `"@"===t&&(o="/xq/query/v1/old/search/user.json",a={q:r,count:5})`。
cli({
    site: 'xueqiu',
    name: 'users',
    access: 'read',
    description: '搜索雪球用户（@某人），返回用户 id + 昵称，供在正文里 @用户取合法值。',
    domain: 'mp.xueqiu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'keyword', positional: true, required: true, help: '用户昵称关键词（不含 @）' },
    ],
    columns: ['user_id', 'name'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('雪球用户搜索需要浏览器会话');
        const keyword = String(kwargs.keyword ?? '').trim();
        if (!keyword) throw new CliError('INVALID_INPUT', '用户关键词不能为空');
        await gotoWritePage(page, xueqiuProfile.home);

        const js =
            '(async () => {\n' +
            '  const kw = ' + JSON.stringify(keyword) + ';\n' +
            '  const r = await fetch("/xq/query/v1/old/search/user.json?q=" + encodeURIComponent(kw) + "&count=5", { credentials: "include" });\n' +
            '  const t = await r.text();\n' +
            '  let j = null; try { j = JSON.parse(t); } catch (e) {}\n' +
            '  if (!r.ok || j == null) return { __err: "用户搜索失败（HTTP " + r.status + "）：" + t.slice(0, 200) };\n' +
            // 响应结构：数组，或 {users:[...]} / {list:[...]} / {data:[...]}；逐一兜底
            '  const list = Array.isArray(j) ? j : (j.users || j.list || j.data || []);\n' +
            '  return list.map(e => ({\n' +
            '    user_id: String(e.id != null ? e.id : (e.user_id != null ? e.user_id : "")),\n' +
            '    name: String(e.screen_name || e.name || ""),\n' +
            '  }));\n' +
            '})()';

        const data = await page.evaluate(js);
        if (data && data.__err) throw new CliError('FETCH_ERROR', data.__err);
        return Array.isArray(data) ? data : [];
    },
});
