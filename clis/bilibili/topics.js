/**
 * B站投稿话题列举 —— `bilibili upload --topic` 的**合法 topic_id 唯一来源**。
 *
 * 话题（topic/活动）是重要流量入口。铁律：禁止 AI 臆造 topic_id，用本命令按分区取真实话题。
 *
 * 接口：GET https://member.bilibili.com/x/vupre/web/topic/type?type_id=<tid>&pn=0&ps=200（需登录）。
 * 出处：忠实取自上游开源 Nemo2011/bilibili-api `get_available_topics(tid)`（`_API["available_topics"]`，
 *   params `{type_id, pn, ps}`，"根据分区获取可用话题，最多 200 个"）。响应 `data.topics[]`，每项含
 *   `topic_id`、`topic_name`、`mission_id`、`description`、`arc_play_vv`（播放量）等。
 *   投稿时 mission_id 与 topic_id 配对，由 `bilibili upload --topic` 自动从此列表匹配，无需手填。
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

// 导航到 member.bilibili.com 并确认真的落在该源（浏览器会话冷启动/偶发会漂到 data: 空白页，
// 直接 fetch 会跨域失败）。同源后才能带 cookie 发投稿中心接口。
async function gotoMember(page) {
  for (let i = 0; i < 6; i++) {
    await page.goto('https://member.bilibili.com/platform/home');
    await page.wait({ time: 1 });
    let href = '';
    try { href = String((await page.evaluate('location.href')) || ''); } catch { href = ''; }
    if (/^https?:\/\/member\.bilibili\.com\//.test(href)) return;
  }
  throw new CommandExecutionError('无法进入 B站创作中心（可能未登录或被风控）。请先在客户端登录哔哩哔哩。');
}

cli({
  site: 'bilibili',
  name: 'topics',
  aliases: ['topic-list'],
  access: 'read',
  description:
    '列出某分区下可参与的投稿话题（topic_id + 名称 + 简介 + 播放量），供 `bilibili upload --topic` 取合法 topic_id。禁止臆造。先用 `bilibili partitions` 取 tid。',
  domain: 'member.bilibili.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'tid', type: 'number', required: true, help: '分区 id（用 `bilibili partitions` 取）。话题按分区提供。' },
  ],
  columns: ['topic_id', 'name', 'play', 'desc'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('B站话题列举需要浏览器会话');
    if (kwargs.tid == null || kwargs.tid === '' || !Number.isFinite(Number(kwargs.tid))) {
      throw new ArgumentError('必须用 --tid 指定分区 id（数字）。用 `bilibili partitions` 列举分区。');
    }
    const tid = Number(kwargs.tid);
    await gotoMember(page);
    const rows = await page.evaluateWithArgs(
      '(async () => {'
      + "const r = await fetch('https://member.bilibili.com/x/vupre/web/topic/type?type_id=' + encodeURIComponent(tid) + '&pn=0&ps=200', { credentials: 'include' });"
      + 'const j = await r.json();'
      + 'if (!j || j.code !== 0 || !j.data || !Array.isArray(j.data.topics)) {'
      + "  throw new Error('获取 B站话题失败（可能未登录 B站）：' + ((j && j.message) || ('code=' + (j && j.code))));"
      + '}'
      + 'return j.data.topics.map(function (t) {'
      + '  return {'
      + '    topic_id: t.topic_id,'
      + '    name: t.topic_name || "",'
      + '    play: t.arc_play_vv != null ? t.arc_play_vv : "",'
      + '    desc: (t.description || t.activity_description || "").slice(0, 60),'
      + '  };'
      + '});'
      + '})()',
      { tid },
    );
    if (!Array.isArray(rows)) throw new CommandExecutionError('未取到话题列表（接口返回异常）');
    if (!rows.length) {
      // 分区合法但无可用话题：返回空表而非报错，AI 据此知道该分区没话题可参与。
      return [];
    }
    return rows;
  },
});
