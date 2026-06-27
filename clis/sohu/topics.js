import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { sohuProfile } from './article.js';

// ── 搜狐号话题列举 / 搜索 ────────────────────────────────────────────────────
// `sohu article --topics` 的合法值来源，禁止 AI 臆造话题名（话题名须与平台完全一致）。
// 不传 --keyword：拉推荐话题列表；传 --keyword：按关键词搜索。两者都要 accountId。
// 出处（mp_micro_contentmanager app.js，已 re-fetch 核验）：
//   推荐：getRecommendTopic(){(0,o.F)("/mpbp/bp/news/v4/label/topic/list?accountId="+(0,a.PU)(),"GET")...}
//   搜索：queryTopic(t){t.trim()&&(0,o.F)("/mpbp/bp/news/v4/label/topic/search?accountId="+(0,a.PU)()+"&keyword="+t.trim(),"GET",...)}
//   返回 data[] 元素含 { id, name, type }。
cli({
    site: 'sohu',
    name: 'topics',
    access: 'read',
    description: '列举/搜索搜狐号话题（id + 名称 + 类型），供 `sohu article --topics` 取确切话题名。不传 --keyword 为推荐话题，传则按关键词搜索。',
    domain: 'mp.sohu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'keyword', help: '搜索关键词；不传则返回推荐话题列表' },
    ],
    columns: ['topic_id', 'topic_name', 'topic_type'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('搜狐号话题列举需要浏览器会话');
        const keyword = typeof kwargs.keyword === 'string' ? kwargs.keyword.trim() : '';
        await gotoWritePage(page, sohuProfile.home);
        const data = await page.evaluate(
            "(async () => {"
            // 先取 accountId
            + "const ar = await fetch('https://mp.sohu.com/mpbp/bp/account/list?_=' + Date.now(), { method: 'GET', credentials: 'include' });"
            + "const aj = await ar.json();"
            + "if (!aj || aj.code !== 2000000 || !(aj.data && aj.data.data && aj.data.data.length)) throw new Error('获取搜狐账号失败，请确认已登录搜狐号');"
            + "let accountId = '';"
            + "for (const g of aj.data.data) { if (g.accounts && g.accounts.length) { accountId = String(g.accounts[0].id); break; } }"
            + "if (!accountId) throw new Error('搜狐号子账号列表为空');"
            + "const kw = " + JSON.stringify(keyword) + ";"
            + "const url = kw"
            + "  ? 'https://mp.sohu.com/mpbp/bp/news/v4/label/topic/search?accountId=' + accountId + '&keyword=' + encodeURIComponent(kw)"
            + "  : 'https://mp.sohu.com/mpbp/bp/news/v4/label/topic/list?accountId=' + accountId;"
            + "const r = await fetch(url, { method: 'GET', credentials: 'include' });"
            + "const j = await r.json();"
            + "if (!j || j.success === false) throw new Error('话题接口失败：' + ((j && j.msg) || '未登录或无权限'));"
            + "return ((j && j.data) || []).map(t => ({ topic_id: String(t.id), topic_name: t.name || '', topic_type: t.type != null ? String(t.type) : '' }));"
            + "})()",
        );
        return Array.isArray(data) ? data : [];
    },
});
