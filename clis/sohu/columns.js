import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { sohuProfile } from './article.js';

// ── 搜狐号专栏列举 ──────────────────────────────────────────────────────────
// `sohu article --column` 的合法值来源，禁止 AI 臆造专栏名。
// 接口：GET /mpbp/bp/account/column/v2/list（纯 cookie）。
// 出处（mp_micro_contentmanager app.js，已 re-fetch 核验）：
//   getColumnList:t=>(0,a.F)("/mpbp/bp/account/column/v2/list","GET",t,!0)
cli({
    site: 'sohu',
    name: 'columns',
    access: 'read',
    description: '列出当前搜狐号的专栏（id + 名称），供 `sohu article --column` 取合法专栏名。',
    domain: 'mp.sohu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['column_id', 'column_name'],
    func: async (page) => {
        if (!page) throw new CommandExecutionError('搜狐号专栏列举需要浏览器会话');
        await gotoWritePage(page, sohuProfile.home);
        const data = await page.evaluate(
            "(async () => {"
            + "const r = await fetch('https://mp.sohu.com/mpbp/bp/account/column/v2/list', { method: 'GET', credentials: 'include' });"
            + "const j = await r.json();"
            + "if (!j || j.success === false) throw new Error('专栏列举失败：' + ((j && j.msg) || '未登录或无权限'));"
            // 兼容 data 直接是数组、或 data.data 是数组两种壳。
            + "const raw = (j && j.data) || [];"
            + "const list = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : []);"
            + "return list.map(c => ({ column_id: String(c.id), column_name: c.name || '' }));"
            + "})()",
        );
        return Array.isArray(data) ? data : [];
    },
});
