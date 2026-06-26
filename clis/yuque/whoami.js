import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin } from '../_shared/article/auth.js';

// 语雀 auth profile：登录检测打 /api/mine/common_used 接口。
// 登录态验证：cookie yuque_ctoken + 接口返回 data.books 非空。
const yuqueAuthProfile = {
    home: 'https://www.yuque.com/dashboard',
    // 页面内执行：取 csrf token → 打接口 → 解析用户信息
    checkAuth: async (PP) => {
        const csrfToken = PP.cookie('yuque_ctoken');
        if (!csrfToken) {
            return { isAuthenticated: false, error: '未检测到 yuque_ctoken cookie，请先登录语雀' };
        }
        try {
            const resp = await fetch('https://www.yuque.com/api/mine/common_used', {
                method: 'GET',
                credentials: 'include',
                headers: { 'x-csrf-token': csrfToken },
            });
            if (!resp.ok) {
                return { isAuthenticated: false, error: '接口返回 HTTP ' + resp.status };
            }
            let data = null;
            try { data = await resp.json(); } catch (e) {}
            if (!data?.data?.books?.length) {
                return { isAuthenticated: false, error: '未获取到语雀知识库信息' };
            }
            const user = data.data.books[0].user;
            return {
                isAuthenticated: true,
                userId: String(user.id),
                username: user.name,
                avatar: user.avatar_url || '',
            };
        } catch (e) {
            return { isAuthenticated: false, error: String((e && e.message) || e) };
        }
    },
};

cli({
    site: 'yuque',
    name: 'whoami',
    access: 'read',
    description: '查看当前语雀登录账号信息。',
    domain: 'www.yuque.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['logged_in', 'user_id', 'username'],
    func: async (page) => {
        const r = await checkLogin(page, yuqueAuthProfile);
        return [{
            logged_in: r.isAuthenticated,
            user_id: r.userId || '',
            username: r.username || '',
        }];
    },
});

export { yuqueAuthProfile };
