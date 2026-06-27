import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { baijiahaoProfile } from './article.js';

// ── 百家号「我的已发布文章」列举 ─────────────────────────────────────────────
// 用途：发布后回查校验幂等（按标题匹配拿 article_id）、查看阅读/推荐量、
//       拿 can_withdraw 状态供后续撤回/删除。
// 接口：GET https://baijiahao.baidu.com/pcui/article/lists
//   query: currentPage / pageSize / search / type / collection / dynamic=1
//   headers: Cookie（同源天然带）+ token（从编辑页抓 __BJH__INIT__AUTH__）
//   响应：{ data: { list: [ { article_id, title, read_amount, rec_amount,
//                            withdraw_status: { can_withdraw } } ] } }
//          can_withdraw: 1=已发布可撤回, -1=可直接删除
// 出处：liulei2020/BatchWithdrawAndDeleteBaiduArticle，GetData.py L17-31。
// 百家号 publish body 不含分类/话题必填字段，也无可发现的分类/话题搜索接口，
// 故本站搜索命令只列举「自己已发布的文章」，不臆造分类枚举接口。
cli({
    site: 'baijiahao',
    name: 'lists',
    access: 'read',
    description: '列出当前账号在百家号已发布的文章（article_id + 标题 + 阅读/推荐量 + 是否可撤回），供发布后回查幂等、取 article_id。',
    domain: 'baijiahao.baidu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'search', help: '按标题关键词过滤（可空）' },
        { name: 'page', help: '页码，默认 1' },
        { name: 'page_size', help: '每页条数，默认 10' },
    ],
    columns: ['article_id', 'title', 'read_amount', 'rec_amount', 'can_withdraw'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('百家号文章列举需要浏览器会话');
        await gotoWritePage(page, baijiahaoProfile.home);

        const search = typeof kwargs.search === 'string' ? kwargs.search : '';
        const currentPage = Number(kwargs.page) > 0 ? Number(kwargs.page) : 1;
        const pageSize = Number(kwargs.page_size) > 0 ? Number(kwargs.page_size) : 10;

        const ctx = JSON.stringify({ search, currentPage, pageSize });
        const data = await page.evaluate(
            '(async () => {'
            + 'const I = ' + ctx + ';'
            // 抓 token（与 publish 同源：编辑页 HTML 里的 __BJH__INIT__AUTH__）。
            + "const er = await fetch('https://baijiahao.baidu.com/builder/rc/edit', { credentials: 'include' });"
            + 'const eh = await er.text();'
            + "const m = eh.match(/window\\.__BJH__INIT__AUTH__\\s*=\\s*['\\\"]([^'\\\"]+)['\\\"]/);"
            + "if (!m) return { __error: '登录失效，请重新登录百家号' };"
            + 'const token = m[1];'
            + "const qs = new URLSearchParams({ currentPage: String(I.currentPage), pageSize: String(I.pageSize), search: I.search || '', type: '', collection: '', dynamic: '1' }).toString();"
            + "const r = await fetch('https://baijiahao.baidu.com/pcui/article/lists?' + qs, { credentials: 'include', headers: { token } });"
            + 'let j = null; try { j = await r.json(); } catch (e) {}'
            + "if (!j || !j.data) return { __error: (j && j.errmsg) || ('列举失败 HTTP ' + r.status) };"
            + 'const list = (j.data && j.data.list) || [];'
            + 'return { rows: list.map(a => ({'
            + ' article_id: String(a.article_id == null ? "" : a.article_id),'
            + ' title: a.title || "",'
            + ' read_amount: a.read_amount == null ? "" : String(a.read_amount),'
            + ' rec_amount: a.rec_amount == null ? "" : String(a.rec_amount),'
            + ' can_withdraw: (a.withdraw_status && a.withdraw_status.can_withdraw != null) ? String(a.withdraw_status.can_withdraw) : ""'
            + ' })) };'
            + '})()',
        );

        if (data && data.__error) {
            throw new CommandExecutionError('百家号文章列举失败：' + data.__error);
        }
        return Array.isArray(data && data.rows) ? data.rows : [];
    },
});
