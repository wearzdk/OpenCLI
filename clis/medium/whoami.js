// @ts-check
import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin, cookieQuickCheck } from '../_shared/article/auth.js';
import { mediumAuthProfile } from './article.js';

// Medium whoami：检测当前登录的 Medium 账户。
// checkAuth 走 GraphQL ViewerQuery（同源 fetch，仅凭会话 cookie）——见 article.js mediumProfile。
cli({
    site: 'medium',
    name: 'whoami',
    access: 'read',
    description: '查询当前登录的 Medium 账户信息。',
    domain: 'medium.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['logged_in', 'user_id', 'username'],
    // 快速登录检测（`auth status` quick / 桌面 GUI 用）：Medium 后台会话由 sid（HttpOnly 会话）
    // + uid（用户标识）承载，均在登录后才写入（cookieQuickCheck 走 CDP getCookies，能读 HttpOnly）。
    // 命中任一即已登录。
    authStatus: {
        quickCheck: cookieQuickCheck('https://medium.com', ['sid', 'uid']),
    },
    func: async (page) => {
        const r = await checkLogin(page, mediumAuthProfile);
        return [{
            logged_in: r.isAuthenticated,
            user_id: r.userId || '',
            username: r.username || '',
        }];
    },
});
