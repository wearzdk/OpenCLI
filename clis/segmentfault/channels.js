import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { segmentfaultProfile } from './article.js';

// ── 思否频道列举 ────────────────────────────────────────────────────────────
// `segmentfault article --channels` 的合法值来源，禁止 AI 臆造频道名/id。
//
// 接口：GET https://segmentfault.com/gateway/channels（Api.getChannels）。鉴权头 Token。
// 出处（已 re-fetch 核验，2026-06-27）：
//   _app bundle .../chunks/pages/_app-5a4e312e0014a428.js 模块 3014
//   `getChannels(){return this.request.send("/channels")}`；base /gateway 来自
//   Request.send `let T="/gateway"+m`。
//
// ⚠️ 频道响应外形未抓到运行时样本（接口路径/方法已从 bundle 确定），故对返回做宽松取数组
//   并尽量提取 id/name；真机首跑请核对列出的频道是否符合预期。
cli({
    site: 'segmentfault',
    name: 'channels',
    access: 'read',
    description: '列出思否文章频道（id + 名称），供 `segmentfault article --channels` 取合法频道名。',
    domain: 'segmentfault.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['channel_id', 'channel_name'],
    func: async (page) => {
        if (!page) throw new CommandExecutionError('思否频道列举需要浏览器会话');

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
            + 'const r = await fetch("https://segmentfault.com/gateway/channels", { credentials: "include", headers: { token: token, accept: "*/*" } });'
            + 'const t = await r.text();'
            + 'let d; try { d = JSON.parse(t); } catch (e) { return { __error: "解析频道响应失败：" + t.slice(0, 200) }; }'
            // 不能把 403/错误静默成空列表：思否 GET /gateway 还需 getUrl() 客户端签名（见 publish-rollout-status），
            // 未带签名返 403「非法请求」(body 是字符串)。此时必须抛错。
            + 'if (!r.ok || typeof d === "string") return { __error: "思否频道接口请求被拒（HTTP " + r.status + "）：" + (typeof d === "string" ? d : t.slice(0, 120)) + "。思否 GET /gateway 需客户端 URL 签名(getUrl/sign)，当前未实现。" };'
            // 宽松取数组：直接数组 / {data} / {rows} / {channels}
            + 'let list = [];'
            + 'if (Array.isArray(d)) list = d;'
            + 'else if (d && Array.isArray(d.data)) list = d.data;'
            + 'else if (d && Array.isArray(d.rows)) list = d.rows;'
            + 'else if (d && Array.isArray(d.channels)) list = d.channels;'
            + 'return list.map((c) => ({ channel_id: String((c && c.id) != null ? c.id : ""), channel_name: String((c && (c.name || c.title || c.text)) || "") }));'
            + '})()';

        const data = await page.evaluate(js);
        if (data && data.__error) throw new CommandExecutionError(data.__error);
        return Array.isArray(data) ? data : [];
    },
});
