import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { oschinaProfile } from './article.js';

// ── 开源中国个人博客分类列举 ────────────────────────────────────────────────
// `oschina article --category` 的合法值来源，禁止 AI 臆造分类名。
// 接口：GET apiv1.oschina.net/oschinapi/blog_catalog/list_by_user（纯 cookie）。
// 出处：OSChina 创作中心 bundle writeType-CEJXAhyC.js Da()。
cli({
    site: 'oschina',
    name: 'catalogs',
    access: 'read',
    description: '列出当前用户的开源中国个人博客分类（id + 名称），供 `oschina article --category` 取合法分类名。',
    domain: 'my.oschina.net',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['catalog_id', 'catalog_name'],
    func: async (page) => {
        if (!page) throw new CommandExecutionError('开源中国分类列举需要浏览器会话');
        await gotoWritePage(page, oschinaProfile.home);
        const data = await page.evaluate(
            "(async () => {"
            + "const r = await fetch('https://apiv1.oschina.net/oschinapi/blog_catalog/list_by_user', { credentials: 'include' });"
            + "const j = await r.json();"
            + "return ((j && j.result) || []).map(c => ({ catalog_id: String(c.id), catalog_name: c.name || '' }));"
            + "})()",
        );
        return Array.isArray(data) ? data : [];
    },
});
