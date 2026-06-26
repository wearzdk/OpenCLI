import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin } from '../_shared/article/auth.js';
import { woshipmProfile } from './article.js';

// whoami：检测人人都是产品经理的当前登录态

const authProfile = {
    home: woshipmProfile.home,
    checkAuth: woshipmProfile.checkAuth,
};

cli({
    site: 'woshipm',
    name: 'whoami',
    access: 'read',
    description: '显示当前登录人人都是产品经理（woshipm.com）的账号信息。',
    domain: 'www.woshipm.com',
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
