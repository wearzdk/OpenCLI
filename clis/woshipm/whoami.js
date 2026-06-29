import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin, cookieQuickCheck } from '../_shared/article/auth.js';
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
    // 快速登录检测（`auth status` quick / 桌面 GUI 用）：站点是 WordPress，登录态由
    // wordpress_logged_in_<hash> 承载（hash 随站固定，按前缀匹配；实测去掉即翻匿名）。
    authStatus: {
        quickCheck: cookieQuickCheck('https://www.woshipm.com', [], ['wordpress_logged_in_']),
    },
    func: async (page) => {
        const r = await checkLogin(page, authProfile);
        return [{
            logged_in: r.isAuthenticated,
            user_id: r.userId || '',
            username: r.username || '',
        }];
    },
});
