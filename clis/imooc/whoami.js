import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin } from '../_shared/article/auth.js';
import { imoocProfile } from './article.js';

// 从 article profile 提取 authProfile（home + checkAuth）
const authProfile = {
    home: imoocProfile.home,
    checkAuth: imoocProfile.checkAuth,
};

cli({
    site: 'imooc',
    name: 'whoami',
    access: 'read',
    description: '查询当前在 Chrome 里登录的慕课网账号。',
    domain: 'www.imooc.com',
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
