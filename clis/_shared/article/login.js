import { cli, Strategy } from '@jackwener/opencli/registry';
import { TimeoutError } from '@jackwener/opencli/errors';
import { checkLogin } from './auth.js';

// ── 文章平台「login」命令共享注册器 ──────────────────────────────────────────
// 走文章共享基建（profile + whoami.js）的平台（juejin / csdn / oschina …）已自带
// whoami（进 `auth status`），但没有 `login` 命令——桌面客户端的「登录」按钮靠
// `opencli <site> login --window foreground` 开登录窗口，缺了它绿点永远不亮。
//
// 这里只注册 `login` 一个命令（不碰各站已有的 whoami，避免重复注册）。登录态判定
// 复用 profile.checkAuth（与 whoami 同源），打开登录页让用户手动完成登录后轮询。
//
// 注意：与 site-auth.js 的 registerSiteAuthCommands 互补——后者同时注册 whoami+login，
// 适用于「auth.js 一把梭」的平台（zhihu/douban/xueqiu）；本注册器适用于「whoami.js +
// 文章 profile」的平台，只补 login。两者别同时用在一个站点上。

const DEFAULT_TIMEOUT_SECONDS = 300;
const POLL_INTERVAL_MS = 3000;

/**
 * 给走文章共享基建的平台注册一个 `login` 命令。
 *
 * @param {object} config
 * @param {string} config.site                 站点 id（如 'juejin'）
 * @param {string} config.domain               主域名（如 'juejin.cn'）
 * @param {{ home: string, checkAuth: Function, originRe?: RegExp }} config.profile
 *        与 whoami 同源的 article profile（必须含 home + checkAuth）
 * @param {string} [config.loginUrl]           登录页地址（默认用 profile.home，未登录通常会被重定向到登录页）
 * @param {string} [config.loginDescription]   命令描述覆盖
 */
export function registerArticleLogin(config) {
    if (!config?.site || !config?.domain || !config?.profile || typeof config.profile.checkAuth !== 'function') {
        throw new Error('registerArticleLogin 需要 site、domain 和 profile.checkAuth');
    }
    const loginUrl = config.loginUrl ?? config.profile.home;

    cli({
        site: config.site,
        name: 'login',
        access: 'write',
        description: config.loginDescription ?? `打开${config.site}登录页并等待浏览器会话完成登录`,
        domain: config.domain,
        strategy: Strategy.COOKIE,
        browser: true,
        navigateBefore: false,
        defaultWindowMode: 'foreground',
        siteSession: 'persistent',
        args: [
            { name: 'timeout', type: 'int', default: DEFAULT_TIMEOUT_SECONDS, help: '等待用户完成登录的最长秒数' },
        ],
        columns: ['status', 'logged_in', 'user_id', 'username'],
        func: async (page, kwargs) => {
            // 已登录直接返回（checkLogin 内部会导航到 home 并探鉴权）。
            const first = await checkLogin(page, config.profile);
            if (first.isAuthenticated) {
                return {
                    status: 'already_logged_in',
                    logged_in: true,
                    user_id: first.userId || '',
                    username: first.username || '',
                };
            }

            // 未登录：打开登录页，让用户手动完成登录，再轮询登录态。
            await page.goto(loginUrl);
            const timeoutSeconds = Number(kwargs.timeout ?? DEFAULT_TIMEOUT_SECONDS);
            const deadline = Date.now() + timeoutSeconds * 1000;

            while (Date.now() < deadline) {
                const remainMs = deadline - Date.now();
                await page.wait(Math.min(POLL_INTERVAL_MS / 1000, Math.max(0.2, remainMs / 1000)));
                const r = await checkLogin(page, config.profile);
                if (r.isAuthenticated) {
                    return {
                        status: 'login_complete',
                        logged_in: true,
                        user_id: r.userId || '',
                        username: r.username || '',
                    };
                }
            }

            throw new TimeoutError(
                `${config.site} login`,
                timeoutSeconds,
                `请在打开的窗口里完成${config.site}登录后重试。`,
            );
        },
    });
}
