import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin, cookieQuickCheck } from '../_shared/article/auth.js';
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
    // 快速登录检测（`auth status` quick / 桌面 GUI 用）：搜狐号登录态由 pprdig
    // 承载（实测：去掉它鉴权接口翻匿名，仅留它也仍登录）。
    authStatus: {
        quickCheck: cookieQuickCheck('https://mp.sohu.com', ['pprdig']),
    },
    func: async (page) => {
        const r = await checkLogin(page, sohuAuthProfile);
        return [{
            logged_in: r.isAuthenticated,
            user_id: r.userId || '',
            username: r.username || '',
        }];
    },
});
