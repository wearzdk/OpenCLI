import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

async function hasWechatChannelsSessionCookie(page) {
  const cookies = await page.getCookies({ url: 'https://channels.weixin.qq.com' });
  return cookies.some(c => c.name === 'sessionid' && c.value);
}

async function verifyWechatChannelsIdentity(page) {
  if (!await hasWechatChannelsSessionCookie(page)) {
    throw new AuthRequiredError('channels.weixin.qq.com', 'WeChat Channels sessionid cookie missing');
  }
  await page.goto('https://channels.weixin.qq.com/platform');
  // SPA 导航 + 可能的 login.html 重定向是异步的：在 page.goto 返回后 document 的 base URL
  // 可能还停在 about:blank，相对 fetch('/cgi-bin/...') 会因无法解析 URL 直接抛异常，被误判成硬错误
  // （COMMAND_EXEC，登录命令直接崩）。改为【有界轮询】等导航 settle 到 channels.weixin.qq.com 源，
  // 用绝对 URL 发请求；任何 fetch/导航类异常都归为可重试，轮询耗尽仍未 settle 才按“需要登录”处理（仿 xiaohongshu 范式）。
  let probe = null;
  for (let i = 0; i < 30; i++) {
    probe = await page.evaluate(`(async () => {
      try {
        var href = location.href || '';
        if (!/^https?:\\/\\/channels\\.weixin\\.qq\\.com/.test(href)) {
          return { kind: 'pending', detail: 'location not settled: ' + href };
        }
        if (/login\\.html/.test(href)) {
          return { kind: 'auth', detail: 'WeChat Channels platform redirected to login.html' };
        }
        const r = await fetch('https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!r.ok) return { kind: 'http', httpStatus: r.status };
        const d = await r.json();
        if (!d || d.base_resp?.ret !== 0) {
          return { kind: 'auth', detail: 'WeChat Channels auth_data base_resp.ret=' + String(d?.base_resp?.ret) };
        }
        const fu = d.data?.finder_user || d.finder_user || {};
        const userId = String(fu.uniq_id || fu.username || '');
        const name = String(fu.nickname || fu.name || '');
        if (!userId && !name) {
          return { kind: 'auth', detail: 'WeChat Channels auth_data 200 but finder_user empty' };
        }
        return { ok: true, user_id: userId, name };
      } catch (e) {
        return { kind: 'pending', detail: String(e && e.message || e) };
      }
    })()`);
    if (probe?.ok || probe?.kind === 'auth' || probe?.kind === 'http') break;
    await page.wait({ time: 0.5 });
  }
  if (probe?.kind === 'auth') throw new AuthRequiredError('channels.weixin.qq.com', probe.detail);
  if (probe?.kind === 'http') throw new CommandExecutionError(`HTTP ${probe.httpStatus} from auth_data`);
  if (probe?.kind === 'pending') {
    throw new AuthRequiredError('channels.weixin.qq.com', `WeChat Channels auth probe not settled: ${probe.detail}`);
  }
  if (!probe?.ok) throw new CommandExecutionError(`Unexpected WeChat Channels probe: ${JSON.stringify(probe)}`);
  return { user_id: probe.user_id, name: probe.name };
}

registerSiteAuthCommands({
  site: 'wechat-channels',
  domain: 'channels.weixin.qq.com',
  loginUrl: 'https://channels.weixin.qq.com/login.html?from=assistant',
  columns: ['user_id', 'name'],
  quickCheck: hasWechatChannelsSessionCookie,
  verify: verifyWechatChannelsIdentity,
  poll: async (page) => {
    if (!await hasWechatChannelsSessionCookie(page)) {
      throw new AuthRequiredError('channels.weixin.qq.com', 'Waiting for WeChat Channels sessionid cookie');
    }
    return verifyWechatChannelsIdentity(page);
  },
});
