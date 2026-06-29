import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin, cookieQuickCheck } from '../_shared/article/auth.js';
import { oschinaProfile } from './article.js';

// 取当前开源中国登录账号（共用 article.js 导出的 oschinaProfile.home + oschinaProfile.checkAuth）。
const authProfile = {
    home: oschinaProfile.home,
    checkAuth: oschinaProfile.checkAuth,
};

cli({
    site: 'oschina',
    name: 'whoami',
    access: 'read',
    description: '查询当前开源中国登录账号信息（登录状态 / 用户 ID / 用户名）。',
    domain: 'my.oschina.net',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['logged_in', 'user_id', 'username'],
    // 快速登录检测（`auth status` quick / 桌面 GUI 用）：开源中国登录态由 oscid
    // 承载（实测：去掉它鉴权接口翻匿名），cookie 写在 .oschina.net 顶域。
    authStatus: {
        quickCheck: cookieQuickCheck('https://my.oschina.net', ['oscid']),
    },
    func: async (page) => {
        const r = await checkLogin(page, authProfile);
        return [
            {
                logged_in: r.isAuthenticated,
                user_id: r.userId || '',
                username: r.username || '',
            },
        ];
    },
});
