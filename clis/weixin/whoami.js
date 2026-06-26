// @ts-check
import { cli, Strategy } from '@jackwener/opencli/registry';
import { checkLogin } from '../_shared/article/auth.js';
import { weixinAuthProfile } from './article.js';

// 微信公众号 whoami：检测当前登录的公众号账户信息。
// checkAuth 移植自 Wechatsync WeixinAdapter.checkAuth()，解析 mp.weixin.qq.com
// 首页 HTML 中的 token / nick_name / user_name / head_img 字段。
cli({
    site: 'weixin',
    name: 'whoami',
    access: 'read',
    description: '查询当前登录的微信公众号账户信息。',
    domain: 'mp.weixin.qq.com',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['logged_in', 'user_id', 'username'],
    func: async (page) => {
        const r = await checkLogin(page, weixinAuthProfile);
        return [{
            logged_in: r.isAuthenticated,
            user_id: r.userId || '',
            username: r.username || '',
        }];
    },
});
