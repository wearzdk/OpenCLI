import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin, cookieQuickCheck } from '../_shared/article/auth.js';
import { csdnProfile } from './article.js';

// checkAuth 与 home 从 article.js 的 csdnProfile 复用，保持单一来源
const authProfile = {
    home: csdnProfile.home,
    originRe: csdnProfile.originRe,
    checkAuth: csdnProfile.checkAuth,
};

cli({
    site: 'csdn',
    name: 'whoami',
    access: 'read',
    description: '查看当前登录的 CSDN 账号信息',
    domain: 'editor.csdn.net',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [],
    columns: ['logged_in', 'user_id', 'username'],
    // 快速登录检测（`auth status` quick / 桌面 GUI 用）：CSDN 登录态由 UserToken
    // 承载（实测：去掉它鉴权接口翻匿名），cookie 写在 .csdn.net 顶域。
    authStatus: {
        quickCheck: cookieQuickCheck('https://www.csdn.net', ['UserToken']),
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
