import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { segmentfaultProfile } from './article.js';

// ── 思否标签校验 / 解析 ─────────────────────────────────────────────────────
// `segmentfault article --tags` 的合法值来源：思否发文 tags 字段要的是 tag id，不能猜。
// 本命令按标签名精确解析，返回该标签是否存在及其真实 id。
//
// 接口：GET https://segmentfault.com/gateway/tag/{name}（Api.queryTagInfo，导出 M.sUO），
//   返回 {tag:{id,name,...}}；标签不存在时无 tag 字段。鉴权头 Token（从写作页 HTML 取）。
// 出处（已 re-fetch 核验，2026-06-27）：
//   _app bundle .../chunks/pages/_app-5a4e312e0014a428.js 模块 3014
//   `queryTagInfo(m){let{tagName:_}=m;return this.request.send("/tag/".concat(_))}`，
//   调用方 Write.js `(0,M.sUO)({tagName:_.tag}).then(e=>{if(e?.tag){...}})`。
//   base /gateway 来自 Request.send `let T="/gateway"+m`。
cli({
    site: 'segmentfault',
    name: 'tags',
    access: 'read',
    description: '按名称校验思否标签是否存在并返回其真实 id，供 `segmentfault article --tags` 取合法标签。思否发文强制选标签，禁止臆造标签名/id。',
    domain: 'segmentfault.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'name', positional: true, required: true, help: '要校验的标签名（精确匹配，如 JavaScript / Vue.js）' },
    ],
    columns: ['exists', 'tag_id', 'tag_name'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('思否标签校验需要浏览器会话');
        const name = String(kwargs.name ?? '').trim();
        if (!name) throw new CliError('INVALID_INPUT', '标签名不能为空');

        await gotoWritePage(page, segmentfaultProfile.home);

        const js =
            '(async () => {'
            // 取 session token（与 article.js publish 同源：从写作页 HTML grep）
            + 'const tr = await fetch("https://segmentfault.com/write", { credentials: "include" });'
            + 'const html = await tr.text();'
            + 'let token = null;'
            + 'const m = html.match(/serverData"\\s*:\\s*\\{\\s*"Token"\\s*:\\s*"([^"]+)"/);'
            + 'if (m) { token = m[1]; } else {'
            + '  const mark = "window.g_initialProps = ";'
            + '  const ai = html.indexOf(mark);'
            + '  if (ai !== -1) { const ei = html.indexOf(";\\n\\t</script>", ai);'
            + '    if (ei !== -1) { try { const c = JSON.parse(html.substring(ai + mark.length, ei)); token = c && c.global && c.global.sessionInfo && c.global.sessionInfo.key; } catch (e) {} } }'
            + '}'
            + 'if (!token) return { __error: "获取思否 session token 失败，请确认已登录" };'
            + 'const name = ' + JSON.stringify(name) + ';'
            + 'const r = await fetch("https://segmentfault.com/gateway/tag/" + encodeURIComponent(name), { credentials: "include", headers: { token: token, accept: "*/*" } });'
            + 'const t = await r.text();'
            + 'let d; try { d = JSON.parse(t); } catch (e) { return { __error: "解析标签响应失败：" + t.slice(0, 200) }; }'
            + 'const tag = d && d.tag;'
            + 'if (!tag || tag.id == null) return [{ exists: false, tag_id: "", tag_name: name }];'
            + 'return [{ exists: true, tag_id: String(tag.id), tag_name: String(tag.name || name) }];'
            + '})()';

        const data = await page.evaluate(js);
        if (data && data.__error) throw new CommandExecutionError(data.__error);
        return Array.isArray(data) ? data : [];
    },
});
