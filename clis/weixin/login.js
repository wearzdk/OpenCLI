import { registerArticleLogin } from '../_shared/article/login.js';
import { weixinAuthProfile } from './article.js';

// 微信公众号 login 命令：补桌面客户端「登录」按钮所需的 `weixin login`。
// 登录态判定复用 weixinAuthProfile.checkAuth（与 whoami 同源），打开公众平台首页，
// 用户扫码登录后轮询登录态。缺了它绿点永远不亮、点登录只能干开站点页。
registerArticleLogin({
    site: 'weixin',
    domain: 'mp.weixin.qq.com',
    profile: {
        home: weixinAuthProfile.home,
        checkAuth: weixinAuthProfile.checkAuth,
    },
    loginDescription: '打开微信公众平台首页并等待浏览器完成扫码登录（供桌面客户端引导登录）。',
});
