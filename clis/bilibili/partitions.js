/**
 * B站视频投稿分区（typelist）列举 —— `bilibili upload --tid` 的**合法值唯一来源**。
 *
 * 铁律：禁止 AI 臆造 tid。投稿要分区 id，就用本命令从 B站真实接口取，别猜。
 *
 * 接口：GET https://member.bilibili.com/x/vupre/web/archive/pre?lang=cn（需登录，同源 member.bilibili.com）。
 * 出处：忠实取自上游开源 Nemo2011/bilibili-api `video_uploader.py` 的 `_pre`（`_API["pre"]`，
 *   params `{lang:"cn"}`）。响应里的分区树：**实时接口的键是 `data.typelist`**（上游那份缓存
 *   json 里叫 `tid_list`，字段结构一致，故两者都兜底读）。分区树：
 *     - 一级分区 parent：{ id, name, children[] }
 *     - 叶子分区 child：{ id（即投稿 tid）, name, parent, parent_name, desc, show }
 *   `child.show === false` 表示该分区当前不开放投稿，过滤掉。
 *
 * 与 `bilibili categories`（专栏文章分类）同一套「列真实合法值供写命令取用」的模式。
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';

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
  name: 'partitions',
  aliases: ['tid-list'],
  access: 'read',
  description:
    '列出 B站视频投稿分区（tid + 名称 + 父分区 + 简介），供 `bilibili upload --tid` 取合法分区 id。禁止臆造 tid。',
  domain: 'member.bilibili.com',
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ['tid', 'name', 'parent', 'parent_name', 'desc'],
  func: async (page) => {
    if (!page) throw new CommandExecutionError('B站分区列举需要浏览器会话');
    // 钉到 member.bilibili.com 源，再发同源 fetch（接口需登录）。
    await gotoMember(page);
    const rows = await page.evaluate(
      '(async () => {'
      + "const r = await fetch('https://member.bilibili.com/x/vupre/web/archive/pre?lang=cn', { credentials: 'include' });"
      + 'const j = await r.json();'
      + 'const tree = j && j.data ? (j.data.typelist || j.data.tid_list) : null;'
      + 'if (!j || j.code !== 0 || !Array.isArray(tree)) {'
      + "  throw new Error('获取 B站视频分区失败（可能未登录 B站）：' + ((j && j.message) || ('code=' + (j && j.code))));"
      + '}'
      + 'const out = [];'
      + 'for (const p of tree) {'
      + '  const kids = Array.isArray(p.children) ? p.children : [];'
      + '  for (const c of kids) {'
      + '    if (!c || c.show === false) continue;'
      + '    out.push({'
      + '      tid: c.id,'
      + '      name: c.name || "",'
      + '      parent: p.id,'
      + '      parent_name: p.name || "",'
      + '      desc: c.desc || c.description || "",'
      + '    });'
      + '  }'
      + '}'
      + 'return out;'
      + '})()'
    );
    if (!Array.isArray(rows) || !rows.length) {
      throw new CommandExecutionError('未取到任何 B站视频分区（接口返回空，可能未登录）');
    }
    return rows;
  },
});
