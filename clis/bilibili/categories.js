import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { bilibiliArticleProfile } from './article.js';

// ── B站专栏文章分类列举 ─────────────────────────────────────────────────────
// `bilibili article --category` 的合法值来源（submit body 的 category 字段），
// 禁止 AI 臆造分类 id。
//
// 接口：GET https://api.bilibili.com/x/article/categories（公开 GET，无需登录）。
// 出处：GitHub czp3009/bilibili-api MainAPI.kt `@GET("/x/article/categories")`，
//   响应形状见 ArticleCategories.kt（data:List<Category>，Category{id,name,parent_id,children}）。
//   已 re-fetch 核验：函数签名、字段名、树形 children 结构均与此一致。
//
// 响应为树形：一级分类含 children 子分类，叶子分类的 id 即 submit 的 category 值。
// 本命令把树拍平输出，并标记每个分类的层级与父分类名，方便 AI 选叶子分类。
cli({
    site: 'bilibili',
    name: 'categories',
    access: 'read',
    description:
        '列出 B站专栏文章分类树（id + 名称 + 父分类），供 `bilibili article --category` 取合法分类 id。优先选叶子分类（is_leaf=true）。',
    domain: 'member.bilibili.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['category_id', 'category_name', 'parent_id', 'parent_name', 'is_leaf'],
    func: async (page) => {
        if (!page) throw new CommandExecutionError('B站专栏分类列举需要浏览器会话');
        // 钉到 bilibili.com 源后再发同源 fetch（接口本身公开，但保持与其它命令一致）
        await gotoWritePage(page, bilibiliArticleProfile.home, bilibiliArticleProfile.originRe);
        const data = await page.evaluate(
            '(async () => {'
            + "const r = await fetch('https://api.bilibili.com/x/article/categories', { credentials: 'include' });"
            + 'const j = await r.json();'
            + 'if (!j || j.code !== 0 || !Array.isArray(j.data)) {'
            + "  throw new Error('获取 B站专栏分类失败：' + ((j && j.message) || ('code=' + (j && j.code))));"
            + '}'
            + 'const out = [];'
            + 'function walk(node, parentName) {'
            + '  const kids = Array.isArray(node.children) ? node.children : [];'
            + '  out.push({'
            + '    category_id: String(node.id),'
            + "    category_name: node.name || '',"
            + '    parent_id: String(node.parent_id == null ? 0 : node.parent_id),'
            + "    parent_name: parentName || '',"
            + '    is_leaf: kids.length === 0,'
            + '  });'
            + '  kids.forEach((c) => walk(c, node.name));'
            + '}'
            + "j.data.forEach((top) => walk(top, ''));"
            + 'return out;'
            + '})()',
        );
        return Array.isArray(data) ? data : [];
    },
});
