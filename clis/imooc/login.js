import { registerArticleLogin } from '../_shared/article/login.js';
import { imoocProfile } from './article.js';

// 慕课网 login 命令：补桌面客户端「登录」按钮所需的 `imooc login`。
// 登录态判定复用 imoocProfile.checkAuth（与 whoami 同源），打开手记发布页（未登录会被
// 重定向到登录页）让用户完成登录。
registerArticleLogin({
    site: 'imooc',
    domain: 'imooc.com',
    profile: {
        home: imoocProfile.home,
        checkAuth: imoocProfile.checkAuth,
    },
    loginDescription: '打开慕课网登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
});
