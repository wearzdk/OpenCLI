import { registerArticleLogin } from '../_shared/article/login.js';
import { oschinaProfile } from './article.js';

// 开源中国 login 命令：补桌面客户端「登录」按钮所需的 `oschina login`。
// 登录态判定复用 oschinaProfile.checkAuth（与 whoami 同源），打开个人主页（未登录会
// 被重定向到登录页）让用户完成登录。
registerArticleLogin({
    site: 'oschina',
    domain: 'oschina.net',
    profile: {
        home: oschinaProfile.home,
        originRe: oschinaProfile.originRe,
        checkAuth: oschinaProfile.checkAuth,
    },
    loginDescription: '打开开源中国登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
});
