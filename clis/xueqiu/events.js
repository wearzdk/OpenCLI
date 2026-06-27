import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { xueqiuProfile } from './article.js';

// ── 雪球原创活动/事件（original_event_id 的合法值来源）─────────────────────────
// 发布 body 的 original_event_id 是「参与的原创活动/话题事件」id（可空）。雪球没有
// 按关键词搜索事件的接口，发现入口是热门事件列举（hot_event/tag.json），再用本命令
// 按 id 校验该事件可用（disabled=false）。
//
//   - 列举（不带 id）：GET /xq/query/v1/hot_event/tag.json?count=5（响应 t.data，每项 {id,title}）
//     出处：write.6d407dcd7d.js getMentionHashtagHotList `_.get("/xq/query/v1/hot_event/tag.json",{count:5})`
//   - 校验（带 --id）：GET /xq/statuses/original/original_event.json?id=<id>
//     响应 originalEvent.{id,tag,disabled}；disabled=true 则不可用。
//     出处：write.6d407dcd7d.js getArticleActivity `ye.get("/xq/statuses/original/original_event.json",{id:t})`。
cli({
    site: 'xueqiu',
    name: 'events',
    access: 'read',
    description: '列举雪球热门原创活动/事件，或用 --id 校验某事件是否可参与。供 `xueqiu article --original-event-id` 取合法值。',
    domain: 'mp.xueqiu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'id', help: '校验某个事件 id 是否可用（返回 tag/disabled）；不传则列举热门事件' },
    ],
    columns: ['id', 'tag', 'disabled'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('雪球事件查询需要浏览器会话');
        await gotoWritePage(page, xueqiuProfile.home);
        const id = typeof kwargs.id === 'string' ? kwargs.id.trim() : '';

        const js =
            '(async () => {\n' +
            '  const id = ' + JSON.stringify(id) + ';\n' +
            '  if (id) {\n' +
            // 按 id 校验：original_event.json
            '    const r = await fetch("/xq/statuses/original/original_event.json?id=" + encodeURIComponent(id), { credentials: "include" });\n' +
            '    const t = await r.text();\n' +
            '    let j = null; try { j = JSON.parse(t); } catch (e) {}\n' +
            '    if (!r.ok || j == null) return { __err: "事件校验失败（HTTP " + r.status + "）：" + t.slice(0, 200) };\n' +
            '    const ev = j.originalEvent;\n' +
            '    if (!ev || ev.id == null) return [];\n' +
            '    return [{ id: String(ev.id), tag: String(ev.tag || ""), disabled: ev.disabled ? "true" : "false" }];\n' +
            '  }\n' +
            // 不带 id：列举热门事件
            '  const r = await fetch("/xq/query/v1/hot_event/tag.json?count=5", { credentials: "include" });\n' +
            '  const t = await r.text();\n' +
            '  let j = null; try { j = JSON.parse(t); } catch (e) {}\n' +
            '  if (!r.ok || j == null) return { __err: "热门事件列举失败（HTTP " + r.status + "）：" + t.slice(0, 200) };\n' +
            '  return ((j && j.data) || []).map(e => ({ id: String(e.id != null ? e.id : ""), tag: String(e.title || ""), disabled: "false" }));\n' +
            '})()';

        const data = await page.evaluate(js);
        if (data && data.__err) throw new CliError('FETCH_ERROR', data.__err);
        return Array.isArray(data) ? data : [];
    },
});
