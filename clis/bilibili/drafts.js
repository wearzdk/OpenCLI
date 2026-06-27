import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { bilibiliArticleProfile } from './article.js';

// ── B站专栏草稿/文章列举 ─────────────────────────────────────────────────────
// 列出当前用户的专栏草稿（含已建草稿的 aid/title），用于：
//   1) 发布后回查校验（确认文章是否落地）；
//   2) 按需取某篇草稿的 aid 去删除（配合 member.bilibili.com/x/web/draft/delete）。
//
// 接口：GET https://api.bilibili.com/x/article/creative/draft/list（需登录 cookie）。
// query: pn(页码) / ps(页大小) / keyword(可空)。
// 出处：GitHub magicdawn/Bilibili-Gate src/modules/bilibili/me/article-draft/api/index.ts
//   （GET /x/article/creative/draft/list，params keyword/ps:10/pn:1，json.artlist?.drafts）。
//   已 re-fetch 核验 spec 引用一致。
cli({
    site: 'bilibili',
    name: 'drafts',
    access: 'read',
    description:
        '列出当前用户的 B站专栏草稿（aid + 标题 + 分类），用于发布后回查或取 aid。',
    domain: 'member.bilibili.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'keyword', help: '按标题关键词过滤（可空）' },
        { name: 'page', type: 'int', default: 1, help: '页码，默认 1' },
        { name: 'size', type: 'int', default: 10, help: '每页条数，默认 10' },
    ],
    columns: ['aid', 'title', 'category', 'words', 'mtime'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('B站专栏草稿列举需要浏览器会话');
        await gotoWritePage(page, bilibiliArticleProfile.home, bilibiliArticleProfile.originRe);
        const keyword = typeof kwargs.keyword === 'string' ? kwargs.keyword : '';
        const pn = Number(kwargs.page) || 1;
        const ps = Number(kwargs.size) || 10;
        const data = await page.evaluate(
            '(async () => {'
            + 'const q = new URLSearchParams();'
            + 'q.set("pn", ' + JSON.stringify(String(pn)) + ');'
            + 'q.set("ps", ' + JSON.stringify(String(ps)) + ');'
            + 'if (' + JSON.stringify(keyword) + ') q.set("keyword", ' + JSON.stringify(keyword) + ');'
            + "const r = await fetch('https://api.bilibili.com/x/article/creative/draft/list?' + q.toString(), { credentials: 'include' });"
            + 'const j = await r.json();'
            + 'if (!j || j.code !== 0) {'
            + "  throw new Error('获取 B站专栏草稿失败：' + ((j && j.message) || ('code=' + (j && j.code))));"
            + '}'
            + 'const drafts = (j.data && j.data.artlist && j.data.artlist.drafts) || [];'
            + 'return drafts.map((d) => ({'
            + '  aid: String(d.aid == null ? "" : d.aid),'
            + '  title: d.title || "",'
            + '  category: (d.category && d.category.name) || String(d.category_id == null ? "" : d.category_id),'
            + '  words: d.words == null ? 0 : d.words,'
            + '  mtime: d.mtime == null ? "" : String(d.mtime),'
            + '}));'
            + '})()',
        );
        return Array.isArray(data) ? data : [];
    },
});
