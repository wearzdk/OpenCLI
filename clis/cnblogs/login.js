import { registerArticleLogin } from '../_shared/article/login.js';
import { cnblogsAuthProfile } from './article.js';

// 博客园 login 命令：补桌面客户端「登录」按钮所需的 `cnblogs login`。
// 登录态判定复用 cnblogsAuthProfile.checkAuth（与 whoami 同源），打开「当前用户」页
// （未登录会被重定向到登录页）让用户完成登录。
registerArticleLogin({
    site: 'cnblogs',
    domain: 'cnblogs.com',
    profile: {
        home: cnblogsAuthProfile.home,
        checkAuth: cnblogsAuthProfile.checkAuth,
    },
    loginDescription: '打开博客园登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
});
