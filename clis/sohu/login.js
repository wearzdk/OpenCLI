import { registerArticleLogin } from '../_shared/article/login.js';
import { sohuAuthProfile } from './article.js';

// 搜狐号 login 命令：补桌面客户端「登录」按钮所需的 `sohu login`。
// 登录态判定复用 sohuAuthProfile.checkAuth（与 whoami 同源），打开搜狐号后台首页
// （未登录会被重定向到登录页）让用户完成登录。
registerArticleLogin({
    site: 'sohu',
    domain: 'mp.sohu.com',
    profile: {
        home: sohuAuthProfile.home,
        checkAuth: sohuAuthProfile.checkAuth,
    },
    loginDescription: '打开搜狐号登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
});
