import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { sohuProfile } from './article.js';

// ── 搜狐号文章属性列举 ───────────────────────────────────────────────────────
// 发布 body.attrIds 的合法值来源（文章属性，如「深度」「独家」等运营标记）。
// 接口：GET /mpbp/bp/news/v4/news/attribute（纯 cookie）。
// 出处（mp_micro_contentmanager app.js，已 re-fetch 核验）：
//   addArticleGetArticleAttrsList:()=>(0,a.F)("/mpbp/bp/news/v4/news/attribute")
//   发布处 t.attrIds=this.attrs.map(t=>t.id) —— 即每个属性对象含 id（+ name 供展示）。
cli({
    site: 'sohu',
    name: 'attributes',
    access: 'read',
    description: '列出搜狐号文章属性候选（id + 名称），供发布时选择文章属性。',
    domain: 'mp.sohu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['attr_id', 'attr_name'],
    func: async (page) => {
        if (!page) throw new CommandExecutionError('搜狐号文章属性列举需要浏览器会话');
        await gotoWritePage(page, sohuProfile.home);
        const data = await page.evaluate(
            "(async () => {"
            + "const r = await fetch('https://mp.sohu.com/mpbp/bp/news/v4/news/attribute', { method: 'GET', credentials: 'include' });"
            + "const j = await r.json();"
            + "if (!j || j.success === false) throw new Error('文章属性列举失败：' + ((j && j.msg) || '未登录或无权限'));"
            + "const raw = (j && j.data) || [];"
            + "const list = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : []);"
            + "return list.map(a => ({ attr_id: String(a.id), attr_name: a.name || a.attrName || '' }));"
            + "})()",
        );
        return Array.isArray(data) ? data : [];
    },
});
