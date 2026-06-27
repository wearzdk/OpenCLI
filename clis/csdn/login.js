import { registerArticleLogin } from '../_shared/article/login.js';
import { csdnProfile } from './article.js';

// CSDN login 命令：补桌面客户端「登录」按钮所需的 `csdn login`。
// 登录态判定复用 csdnProfile.checkAuth（与 whoami 同源）；直接打开 passport 登录页，
// 比打开编辑器再被重定向更直观。
registerArticleLogin({
    site: 'csdn',
    domain: 'csdn.net',
    profile: {
        home: csdnProfile.home,
        originRe: csdnProfile.originRe,
        checkAuth: csdnProfile.checkAuth,
    },
    loginUrl: 'https://passport.csdn.net/login',
    loginDescription: '打开 CSDN 登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
});
