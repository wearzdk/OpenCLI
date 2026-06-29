import { registerArticleLogin } from '../_shared/article/login.js';
import { authProfile } from './whoami.js';

// 思否 login 命令：补桌面客户端「登录」按钮所需的 `segmentfault login`。
// 思否的 checkAuth 写在 whoami.js（已 export authProfile），这里复用同一来源，避免
// 重复定义。打开 /user/settings（未登录会被重定向到登录页）让用户完成登录。
registerArticleLogin({
    site: 'segmentfault',
    domain: 'segmentfault.com',
    profile: {
        home: authProfile.home,
        checkAuth: authProfile.checkAuth,
    },
    loginDescription: '打开思否（SegmentFault）登录页并等待浏览器完成登录（供桌面客户端引导登录）。',
});
