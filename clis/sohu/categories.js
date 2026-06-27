import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { sohuProfile } from './article.js';

// ── 搜狐号分类列举（依赖频道）─────────────────────────────────────────────────
// `sohu article --category` 的合法值来源；分类挂在某个频道下，须先给频道名。
// 接口：GET /mpbp/bp/account/common/channels/{channelId}/categories（纯 cookie）。
// 出处（mp_micro_contentmanager app.js，已 re-fetch 核验）：
//   addArticleGetCategoryList:t=>(0,a.F)("/mpbp/bp/account/common/channels/"+t+"/categories","GET")
//   store action 把每个元素的 cmsChannelId/cmsPName/createTime/parents/status/rank/type/url/channelId 删掉，留 id+name。
cli({
    site: 'sohu',
    name: 'categories',
    access: 'read',
    description: '列出某个搜狐号频道下的分类（id + 名称），供 `sohu article --category` 取合法分类名。须用 --channel 指定频道名。',
    domain: 'mp.sohu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'channel', required: true, help: '频道名（精确匹配），合法值用 `sohu channels` 列举' },
    ],
    columns: ['category_id', 'category_name'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('搜狐号分类列举需要浏览器会话');
        const channelName = String(kwargs.channel ?? '').trim();
        if (!channelName) throw new CliError('INVALID_INPUT', '请用 --channel 指定频道名');
        await gotoWritePage(page, sohuProfile.home);

        // 先把频道名解析成 channelId（精确匹配），再取该频道下分类。
        const data = await page.evaluate(
            "(async () => {"
            + "const cr = await fetch('https://mp.sohu.com/mpbp/bp/account/common/channels-data-api?status=1', { method: 'GET', credentials: 'include' });"
            + "const cj = await cr.json();"
            + "if (!cj || cj.success === false) throw new Error('频道列举失败：' + ((cj && cj.msg) || '未登录或无权限'));"
            + "const channels = (cj && cj.data) || [];"
            + "const ch = channels.find(c => String(c.name) === " + JSON.stringify(channelName) + ");"
            + "if (!ch) throw new Error('未找到频道「" + channelName.replace(/"/g, '\\"') + "」，可选：' + (channels.map(c => c.name).join(' / ') || '（空）'));"
            + "const channelId = ch.id != null ? ch.id : ch.channelId;"
            + "const r = await fetch('https://mp.sohu.com/mpbp/bp/account/common/channels/' + channelId + '/categories', { method: 'GET', credentials: 'include' });"
            + "const j = await r.json();"
            + "if (!j || j.success === false) throw new Error('分类列举失败：' + ((j && j.msg) || '未登录或无权限'));"
            + "return ((j && j.data) || []).map(c => ({ category_id: String(c.id), category_name: c.name || '' }));"
            + "})()",
        );
        return Array.isArray(data) ? data : [];
    },
});
