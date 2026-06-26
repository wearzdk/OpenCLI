import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin } from '../_shared/article/auth.js';
import { cto51Profile } from './article.js';

// 复用 article.js 里的 home + checkAuth，组成 whoami 用的 authProfile
const authProfile = {
    home: cto51Profile.home,
    checkAuth: cto51Profile.checkAuth,
};

cli({
    site: 'cto51',
    name: 'whoami',
    access: 'read',
    description: '查看当前 51CTO 登录账号信息。',
    domain: 'blog.51cto.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['logged_in', 'user_id', 'username'],
    func: async (page) => {
        const r = await checkLogin(page, authProfile);
        return [{
            logged_in: r.isAuthenticated,
            user_id: r.userId || '',
            username: r.username || '',
        }];
    },
});
