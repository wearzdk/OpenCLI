/**
 * B站视频投稿草稿箱列举 —— 查看 `bilibili upload --draft` 存下的视频草稿。
 *
 * 注意与 `bilibili drafts`（专栏文章草稿）区分：本命令是**视频投稿**草稿，端点不同。
 *
 * 接口：GET https://member.bilibili.com/x/vupre/web/draft/list（需登录）。
 * 出处：开源 deluxebear/bilibilicli `listDrafts` / difyz9/bilibili-go-sdk `draft/list`。
 *   响应 `data` 为草稿数组，每项含 id / title / cid / cover / mtime / duration / validate 等。
 *   草稿 id 可用于后续编辑/发布/删除（draft/edit、draft/delete，本命令暂只做列举）。
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';

// 导航到 member.bilibili.com 并确认真的落在该源（冷启动会漂到 data: 空白页，直接 fetch 会跨域失败）。
async function gotoMember(page) {
  for (let i = 0; i < 6; i++) {
    await page.goto('https://member.bilibili.com/platform/upload-manager/article?group=draft');
    await page.wait({ time: 1 });
    let href = '';
    try { href = String((await page.evaluate('location.href')) || ''); } catch { href = ''; }
    if (/^https?:\/\/member\.bilibili\.com\//.test(href)) return;
  }
  throw new CommandExecutionError('无法进入 B站创作中心（可能未登录或被风控）。请先在客户端登录哔哩哔哩。');
}

cli({
  site: 'bilibili',
  name: 'video-drafts',
  aliases: ['upload-drafts'],
  access: 'read',
  description: '列出 B站视频投稿草稿箱里的草稿（id + 标题 + 时长 + 修改时间），供确认 `bilibili upload --draft` 结果。（专栏草稿见 `bilibili drafts`）',
  domain: 'member.bilibili.com',
  strategy: Strategy.COOKIE,
  browser: true,
  columns: ['id', 'title', 'duration', 'mtime', 'cid'],
  func: async (page) => {
    if (!page) throw new CommandExecutionError('B站视频草稿列举需要浏览器会话');
    await gotoMember(page);
    const rows = await page.evaluate(
      '(async () => {'
      + "const r = await fetch('https://member.bilibili.com/x/vupre/web/draft/list', { credentials: 'include' });"
      + 'const j = await r.json();'
      + 'if (!j || j.code !== 0) {'
      + "  throw new Error('获取 B站视频草稿失败（可能未登录 B站）：' + ((j && j.message) || ('code=' + (j && j.code))));"
      + '}'
      + 'const arr = Array.isArray(j.data) ? j.data : (j.data && Array.isArray(j.data.drafts) ? j.data.drafts : []);'
      + 'return arr.map(function (d) {'
      + '  return {'
      + '    id: d.id,'
      + '    title: d.title || "",'
      + '    duration: d.duration != null ? d.duration : "",'
      + '    mtime: d.mtime != null ? d.mtime : "",'
      + '    cid: d.cid != null ? d.cid : "",'
      + '  };'
      + '});'
      + '})()',
    );
    if (!Array.isArray(rows)) throw new CommandExecutionError('未取到视频草稿列表（接口返回异常）');
    return rows; // 空数组=草稿箱为空，正常返回
  },
});
