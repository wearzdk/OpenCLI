import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin } from '../_shared/article/auth.js';
import { sohuAuthProfile } from './article.js';

cli({
    site: 'sohu',
    name: 'whoami',
    access: 'read',
    description: '查看当前搜狐号登录账号信息（用户名、用户 ID）。',
    domain: 'mp.sohu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['logged_in', 'user_id', 'username'],
    func: async (page) => {
        const r = await checkLogin(page, sohuAuthProfile);
        return [{
            logged_in: r.isAuthenticated,
            user_id: r.userId || '',
            username: r.username || '',
        }];
    },
});
