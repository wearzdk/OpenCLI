import { registerArticleLogin } from '../_shared/article/login.js';
import { baijiahaoProfile } from './article.js';

// 百家号 login 命令：补桌面客户端「登录」按钮所需的 `baijiahao login`。
// 登录态判定复用 baijiahaoProfile.checkAuth（与 whoami 同源），打开百家号首页让用户
// 完成（百度统一）登录。
registerArticleLogin({
    site: 'baijiahao',
    domain: 'baijiahao.baidu.com',
    profile: {
        home: baijiahaoProfile.home,
        checkAuth: baijiahaoProfile.checkAuth,
    },
    loginDescription: '打开百家号登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
});
