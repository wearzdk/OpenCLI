import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin, cookieQuickCheck } from '../_shared/article/auth.js';
import { cnblogsAuthProfile } from './article.js';

cli({
    site: 'cnblogs',
    name: 'whoami',
    access: 'read',
    description: '查看当前博客园登录账号信息。',
    domain: 'cnblogs.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['logged_in', 'user_id', 'username'],
    // 快速登录检测（`auth status` quick / 桌面 GUI 用）：博客园登录态由
    // .Cnblogs.AspNetCore.Cookies 承载（实测：去掉它鉴权接口翻匿名）。
    authStatus: {
        quickCheck: cookieQuickCheck('https://home.cnblogs.com', ['.Cnblogs.AspNetCore.Cookies']),
    },
    func: async (page) => {
        const r = await checkLogin(page, cnblogsAuthProfile);
        return [{
            logged_in: r.isAuthenticated,
            user_id: r.userId || '',
            username: r.username || '',
        }];
    },
});
