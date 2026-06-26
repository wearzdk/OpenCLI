import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin } from '../_shared/article/auth.js';
import { baijiahaoProfile } from './article.js';

// 构建 auth profile：只需 home + checkAuth，直接复用 article.js 导出的 profile。
const authProfile = {
    home: baijiahaoProfile.home,
    checkAuth: baijiahaoProfile.checkAuth,
};

cli({
    site: 'baijiahao',
    name: 'whoami',
    access: 'read',
    description: '检测百家号当前登录状态，返回账号信息。',
    domain: 'baijiahao.baidu.com',
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
