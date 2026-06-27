import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { xueqiuProfile } from './article.js';

// ── 雪球个股（$股票$）联想搜索 ──────────────────────────────────────────────────
// 个股不是发布 body 字段，而是写进正文 HTML 的 mention（输入 $ 触发联想）。
// 本命令供 AI 在正文里嵌入股票 mention 前取得真实代码（symbol），禁止臆造。
// 接口：GET /xq/query/v1/search/stock.json?size=5&code=<关键词>
// 出处：write.6d407dcd7d.js searchMention 默认分支 `o="/xq/query/v1/search/stock.json",a={size:5,code:r}`。
cli({
    site: 'xueqiu',
    name: 'stocks',
    access: 'read',
    description: '搜索雪球个股（$股票$），返回代码 + 名称，供在正文里嵌入股票 mention 取合法值。',
    domain: 'mp.xueqiu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'keyword', positional: true, required: true, help: '股票关键词（名称/代码片段，不含 $）' },
    ],
    columns: ['symbol', 'name', 'exchange'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('雪球个股搜索需要浏览器会话');
        const keyword = String(kwargs.keyword ?? '').trim();
        if (!keyword) throw new CliError('INVALID_INPUT', '股票关键词不能为空');
        await gotoWritePage(page, xueqiuProfile.home);

        const js =
            '(async () => {\n' +
            '  const kw = ' + JSON.stringify(keyword) + ';\n' +
            '  const r = await fetch("/xq/query/v1/search/stock.json?size=5&code=" + encodeURIComponent(kw), { credentials: "include" });\n' +
            '  const t = await r.text();\n' +
            '  let j = null; try { j = JSON.parse(t); } catch (e) {}\n' +
            '  if (!r.ok || j == null) return { __err: "个股搜索失败（HTTP " + r.status + "）：" + t.slice(0, 200) };\n' +
            // 响应结构：数组，或 {stocks:[...]} / {data:[...]} / {list:[...]}；逐一兜底
            '  const list = Array.isArray(j) ? j : (j.stocks || j.data || j.list || []);\n' +
            '  return list.map(e => ({\n' +
            '    symbol: String(e.code || e.symbol || ""),\n' +
            '    name: String(e.name || e.stock_name || ""),\n' +
            '    exchange: String(e.exchange || e.market || ""),\n' +
            '  }));\n' +
            '})()';

        const data = await page.evaluate(js);
        if (data && data.__err) throw new CliError('FETCH_ERROR', data.__err);
        return Array.isArray(data) ? data : [];
    },
});
