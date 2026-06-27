import { registerArticleLogin } from '../_shared/article/login.js';
import { juejinProfile } from './article.js';

// 掘金 login 命令：补桌面客户端「登录」按钮所需的 `juejin login`。
// 登录态判定复用 juejinProfile.checkAuth（与 whoami 同源），打开掘金首页让用户点登录。
registerArticleLogin({
    site: 'juejin',
    domain: 'juejin.cn',
    profile: {
        home: juejinProfile.home,
        originRe: juejinProfile.originRe,
        checkAuth: juejinProfile.checkAuth,
    },
    loginDescription: '打开掘金首页并等待浏览器完成登录（供桌面客户端引导登录）。',
});
