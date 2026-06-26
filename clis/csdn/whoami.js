import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin } from '../_shared/article/auth.js';
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
