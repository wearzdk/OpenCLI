import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin, cookieQuickCheck } from '../_shared/article/auth.js';
import { segmentfaultProfile } from './article.js';

// 思否 checkAuth：移植自 Wechatsync SegmentfaultAdapter.checkAuth()。
// 请求 /user/settings 页面，从 HTML 中解析当前用户链接（/u/username）和头像。
const authProfile = {
    home: segmentfaultProfile.home,
    checkAuth: async (PP) => {
        const res = await fetch('https://segmentfault.com/user/settings', { credentials: 'include' });
        const html = await res.text();

        // 匹配用户链接，格式：href="/u/username"
        const userLinkMatch = html.match(/href="\/u\/([^"]+)"/);
        if (!userLinkMatch) {
            return { isAuthenticated: false, error: '未登录或无法解析用户信息' };
        }
        const uid = userLinkMatch[1];

        // 匹配头像 URL
        const avatarMatch = html.match(/src="(https:\/\/avatar-static\.segmentfault\.com\/[^"]+)"/);
        const avatar = avatarMatch ? avatarMatch[1] : '';

        return {
            isAuthenticated: true,
            userId: uid,
            username: uid,
            avatar: avatar,
        };
    },
};

export { authProfile };

cli({
    site: 'segmentfault',
    name: 'whoami',
    access: 'read',
    description: '检查思否（SegmentFault）的登录状态并获取当前账号信息',
    domain: 'segmentfault.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['logged_in', 'user_id', 'username'],
    // 快速登录检测（`auth status` quick / 桌面 GUI 用）：思否登录态由 PHPSESSID
    // 承载（实测：去掉它鉴权接口翻匿名，仅留它也仍登录）。
    authStatus: {
        quickCheck: cookieQuickCheck('https://segmentfault.com', ['PHPSESSID']),
    },
    func: async (page) => {
        const r = await checkLogin(page, authProfile);
        return [{ logged_in: r.isAuthenticated, user_id: r.userId, username: r.username }];
    },
});
