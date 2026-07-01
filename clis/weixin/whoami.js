// @ts-check
import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin, cookieQuickCheck } from '../_shared/article/auth.js';
import { weixinAuthProfile } from './article.js';

// 微信公众号 whoami：检测当前登录的公众号账户信息。
// checkAuth 移植自 Wechatsync WeixinAdapter.checkAuth()，解析 mp.weixin.qq.com
// 首页 HTML 中的 nick_name / user_name / head_img 字段。
cli({
    site: 'weixin',
    name: 'whoami',
    access: 'read',
    description: '查询当前登录的微信公众号账户信息。',
    domain: 'mp.weixin.qq.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['logged_in', 'user_id', 'username'],
    // 快速登录检测（`auth status` quick / 桌面 GUI 用）：mp.weixin.qq.com 后台会话
    // 由 slave_sid（HttpOnly 会话）+ slave_user（gh_ 账号）承载，均在登录后才写入
    // （实测：未登录只有 _qimei/_clck 等跟踪 cookie，扫码登录后才出现 slave_* 一组）。
    // 命中任一即已登录。
    authStatus: {
        quickCheck: cookieQuickCheck('https://mp.weixin.qq.com', ['slave_sid', 'slave_user']),
    },
    func: async (page) => {
        const r = await checkLogin(page, weixinAuthProfile);
        return [{
            logged_in: r.isAuthenticated,
            user_id: r.userId || '',
            username: r.username || '',
        }];
    },
});
