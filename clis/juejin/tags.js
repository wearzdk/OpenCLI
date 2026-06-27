import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';

// ── 掘金标签搜索 ────────────────────────────────────────────────────────────
// 给 `juejin article --tags` 提供合法取值来源：AI 先按关键词搜标签拿到准确标签名，
// 再按名传入发布，避免猜标签。接口 tag_api/v1/query_tag_list（真机验证）。
cli({
    site: 'juejin',
    name: 'tags',
    access: 'read',
    description: '按关键词搜索掘金标签，返回标签 id 和名称，供 `juejin article --tags` 取准确标签名。',
    domain: 'juejin.cn',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'keyword', positional: true, required: true, help: '标签搜索关键词，如 "Linux"、"AI"' },
    ],
    columns: ['tag_id', 'tag_name'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('掘金标签搜索需要浏览器会话');
        const keyword = String(kwargs.keyword ?? '').trim();
        if (!keyword) throw new CliError('INVALID_INPUT', '请提供标签搜索关键词');
        await gotoWritePage(page, 'https://juejin.cn');
        const data = await page.evaluate(
            "(async () => {"
            + "const r = await fetch('https://api.juejin.cn/tag_api/v1/query_tag_list', {"
            + "  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },"
            + "  body: JSON.stringify({ cursor: '0', key_word: " + JSON.stringify(keyword) + ", limit: 20, sort_type: 1 }),"
            + "});"
            + "const j = await r.json();"
            + "return ((j && j.data) || []).map(x => { const t = (x && x.tag) ? x.tag : x; return { tag_id: String(t.tag_id || ''), tag_name: t.tag_name || '' }; });"
            + "})()",
        );
        return Array.isArray(data) ? data : [];
    },
});
