import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

async function hasDoubanSessionCookie(page) {
  const cookies = await page.getCookies({ url: 'https://www.douban.com' });
  const names = new Set(cookies.map(c => c.name));
  return names.has('dbcl2') || names.has('ck');
}

async function verifyDoubanIdentity(page) {
  if (!await hasDoubanSessionCookie(page)) {
    throw new AuthRequiredError('douban.com', 'Douban dbcl2 / ck cookies missing');
  }
  // 豆瓣改版后导航里已无 /people/<数字id>/ 链接（“个人主页”指向 /mine/，.bn-more 指向账号设置页），
  // 且 dbcl2 是 HttpOnly、document.cookie 读不到。改走 /mine/：它会 302 跳到 /people/<id>/，
  // 从最终 URL 解析数字 user_id（DOM-free，最稳）。用户名再从个人主页/导航读。
  await page.goto('https://www.douban.com/mine/');
  await page.wait(2);
  const probe = await page.evaluate(`
    (() => {
      const href = location.href;
      const m = href.match(/people\\/(\\d+)\\/?/);
      const user_id = m ? m[1] : '';
      if (!user_id) {
        return { kind: 'auth', detail: 'Douban user_id parse failed (mine redirect): href=' + href };
      }
      let name = '';
      const h1 = document.querySelector('.info h1');
      if (h1) {
        const node = h1.childNodes[0];
        name = ((node && node.textContent) || h1.textContent || '').trim();
      }
      if (!name) {
        const bn = document.querySelector('.bn-more');
        if (bn) name = (bn.textContent || '').replace(/的账号$|的帐号$/, '').trim();
      }
      return { ok: true, user_id, name };
    })()
  `);
  if (probe?.kind === 'auth') throw new AuthRequiredError('douban.com', probe.detail);
  if (!probe?.ok) throw new CommandExecutionError(`Unexpected Douban probe: ${JSON.stringify(probe)}`);
  return { user_id: probe.user_id, name: probe.name };
}

registerSiteAuthCommands({
  site: 'douban',
  domain: 'douban.com',
  loginUrl: 'https://accounts.douban.com/passport/login',
  columns: ['user_id', 'name'],
  quickCheck: hasDoubanSessionCookie,
  verify: verifyDoubanIdentity,
  poll: async (page) => {
    if (!await hasDoubanSessionCookie(page)) {
      throw new AuthRequiredError('douban.com', 'Waiting for Douban dbcl2 / ck cookies');
    }
    return verifyDoubanIdentity(page);
  },
});
