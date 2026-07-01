import { registerArticleLogin } from '../_shared/article/login.js';
import { mediumAuthProfile } from './article.js';

// Medium login 命令：补桌面客户端「登录」按钮所需的 `medium login`。
// 登录态判定复用 mediumAuthProfile.checkAuth（GraphQL ViewerQuery，与 whoami 同源），
// 打开 medium.com 首页，用户完成登录后轮询登录态。缺了它绿点永远不亮、点登录只能干开站点页。
registerArticleLogin({
    site: 'medium',
    domain: 'medium.com',
    profile: {
        home: mediumAuthProfile.home,
        checkAuth: mediumAuthProfile.checkAuth,
    },
    loginDescription: '打开 Medium 首页并等待浏览器完成登录（供桌面客户端引导登录）。',
});
