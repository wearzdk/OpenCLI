import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { sohuProfile } from './article.js';

// ── 搜狐号频道列举 ──────────────────────────────────────────────────────────
// `sohu article --channel` 的合法值来源，禁止 AI 臆造频道名。
// 接口：GET /mpbp/bp/account/common/channels-data-api?status=1（纯 cookie）。
// 出处（mp_micro_contentmanager app.js，已 re-fetch 核验）：
//   addArticleGetChannelList:()=>(0,a.F)("/mpbp/bp/account/common/channels-data-api?status=1","GET")
//   UI 下拉：mp-select label:"name" value:"id" —— 即每个频道对象含 id + name。
cli({
    site: 'sohu',
    name: 'channels',
    access: 'read',
    description: '列出当前搜狐号可发布的频道（id + 名称），供 `sohu article --channel` 取合法频道名。',
    domain: 'mp.sohu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['channel_id', 'channel_name'],
    func: async (page) => {
        if (!page) throw new CommandExecutionError('搜狐号频道列举需要浏览器会话');
        await gotoWritePage(page, sohuProfile.home);
        const data = await page.evaluate(
            "(async () => {"
            + "const r = await fetch('https://mp.sohu.com/mpbp/bp/account/common/channels-data-api?status=1', { method: 'GET', credentials: 'include' });"
            + "const j = await r.json();"
            + "if (!j || j.success === false) throw new Error('频道列举失败：' + ((j && j.msg) || '未登录或无权限'));"
            + "return ((j && j.data) || []).map(c => ({ channel_id: String(c.id != null ? c.id : c.channelId), channel_name: c.name || '' }));"
            + "})()",
        );
        return Array.isArray(data) ? data : [];
    },
});
