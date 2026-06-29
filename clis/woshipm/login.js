import { registerArticleLogin } from '../_shared/article/login.js';
import { woshipmProfile } from './article.js';

// 人人都是产品经理 login 命令：补桌面客户端「登录」按钮所需的 `woshipm login`。
// 登录态判定复用 woshipmProfile.checkAuth（与 whoami 同源），打开写作页（未登录会被
// 重定向到登录页）让用户完成登录。
registerArticleLogin({
    site: 'woshipm',
    domain: 'woshipm.com',
    profile: {
        home: woshipmProfile.home,
        checkAuth: woshipmProfile.checkAuth,
    },
    loginDescription: '打开人人都是产品经理登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
});
