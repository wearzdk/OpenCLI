import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';

// ── 掘金分类列举 ────────────────────────────────────────────────────────────
// 给 `juejin article --category` 提供合法取值来源：AI 先列分类拿到准确名称，
// 再按名传入发布，避免猜分类。接口 tag_api/v1/query_category_briefs（真机验证）。
cli({
    site: 'juejin',
    name: 'categories',
    access: 'read',
    description: '列出掘金全部文章分类（id + 名称），供 `juejin article --category` 取准确分类名。',
    domain: 'juejin.cn',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['category_id', 'category_name'],
    func: async (page) => {
        if (!page) throw new CommandExecutionError('掘金分类列举需要浏览器会话');
        await gotoWritePage(page, juejinHome());
        const data = await page.evaluate(
            "(async () => {"
            + "const r = await fetch('https://api.juejin.cn/tag_api/v1/query_category_briefs', { credentials: 'include' });"
            + "const j = await r.json();"
            + "return (j && j.data || []).map(c => ({ category_id: String(c.category_id), category_name: c.category_name }));"
            + "})()",
        );
        if (!Array.isArray(data) || !data.length) {
            throw new CommandExecutionError('未取到掘金分类（可能未登录掘金）');
        }
        return data;
    },
});

function juejinHome() {
    return 'https://juejin.cn';
}
