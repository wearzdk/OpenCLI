import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin, cookieQuickCheck } from '../_shared/article/auth.js';
import { juejinProfile } from './article.js';

// ── 掘金登录状态检测（whoami）──────────────────────────────────────────────
// authProfile 复用 article.js 里导出的 juejinProfile（共享 home 和 checkAuth）。
const authProfile = {
    home: juejinProfile.home,
    checkAuth: juejinProfile.checkAuth,
};

cli({
    site: 'juejin',
    name: 'whoami',
    access: 'read',
    description: '检测掘金当前登录状态，返回用户 ID 和用户名。',
    domain: 'juejin.cn',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['logged_in', 'user_id', 'username'],
    // 快速登录检测（`auth status` quick / 桌面 GUI 用）：掘金登录态由字节跳动 session
    // cookie 承载（实测：去掉 sessionid 系列即翻匿名），命中任一即已登录。
    authStatus: {
        quickCheck: cookieQuickCheck('https://juejin.cn', ['sessionid', 'sessionid_ss', 'sid_tt']),
    },
    func: async (page) => {
        const r = await checkLogin(page, authProfile);
        return [{
            logged_in: r.isAuthenticated,
            user_id: r.userId || '',
            username: r.username || '',
        }];
    },
});
