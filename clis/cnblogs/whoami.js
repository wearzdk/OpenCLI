import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin } from '../_shared/article/auth.js';
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
    func: async (page) => {
        const r = await checkLogin(page, cnblogsAuthProfile);
        return [{
            logged_in: r.isAuthenticated,
            user_id: r.userId || '',
            username: r.username || '',
        }];
    },
});
