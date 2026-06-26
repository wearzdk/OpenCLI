import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin } from '../_shared/article/auth.js';
import { authProfile } from './article.js';

cli({
    site: 'eastmoney',
    name: 'whoami',
    access: 'read',
    description: '查询当前东方财富财富号登录账号',
    domain: 'mp.eastmoney.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['logged_in', 'user_id', 'username'],
    func: async (page) => {
        const r = await checkLogin(page, authProfile);
        return [{ logged_in: r.isAuthenticated, user_id: r.userId, username: r.username }];
    },
});
