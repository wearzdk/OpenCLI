import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin } from '../_shared/article/auth.js';
import { juejinProfile } from './article.js';

// ── 掘金登录状态检测（whoami）──────────────────────────────────────────────
// authProfile 复用 article.js 里导出的 juejinProfile（共享 home 和 checkAuth）。
const authProfile = {
    home: juejinProfile.home,
    checkAuth: juejinProfile.checkAuth,
};

cli({
    site: 'juejin',
    name: 'whoami',
    access: 'read',
    description: '检测掘金当前登录状态，返回用户 ID 和用户名。',
    domain: 'juejin.cn',
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
