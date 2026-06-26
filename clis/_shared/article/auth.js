/**
 * 登录检测 / whoami（共享基础设施）
 *
 * 移植自 Wechatsync 各平台适配器的 `checkAuth()`：在平台页面上下文里打一个「取当前用户」
 * 的接口，登录了就返回账号信息，没登录就返回 isAuthenticated:false。
 *
 * 两个用途共用同一份 profile.checkAuth：
 *   - `<site> whoami`         —— 展示当前登录账号（opencli 既有约定）
 *   - 发布前的登录前置检测     —— 没登录直接抛错，省得发布到一半才失败
 *
 * 同样走单次 evaluate（带 cookie、同源），不依赖任何 Node 侧凭据。
 *
 * @typedef {object} AuthProfile
 * @property {string} home  导航地址（取用户接口要在该源下才带 cookie）
 * @property {string} [originRe]
 * @property {Function} checkAuth  页面内执行 `async (PP) => ({ isAuthenticated, userId?, username?, avatar? })`
 */
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { PAGE_RUNTIME } from './page-runtime.js';
import { gotoWritePage } from './publish.js';

/**
 * 拼出登录检测的单次 evaluate 源码。
 * @param {string} checkAuthFnSource
 * @returns {string}
 */
export function buildCheckAuthJs(checkAuthFnSource) {
    return (
        '(async () => {\n' +
        PAGE_RUNTIME + '\n' +
        'const __checkAuth = (' + checkAuthFnSource + ');\n' +
        'try {\n' +
        '  const r = await __checkAuth(PP);\n' +
        '  return {\n' +
        '    isAuthenticated: !!(r && r.isAuthenticated),\n' +
        '    userId: (r && r.userId != null) ? String(r.userId) : "",\n' +
        '    username: (r && r.username) || "",\n' +
        '    avatar: (r && r.avatar) || "",\n' +
        '    error: (r && r.error) || "",\n' +
        '  };\n' +
        '} catch (e) {\n' +
        '  return { isAuthenticated: false, userId: "", username: "", avatar: "", error: String((e && e.message) || e) };\n' +
        '}\n' +
        '})()'
    );
}

/**
 * 在平台页面里检测登录态并取账号信息。
 *
 * @param {{ goto: Function, wait: Function, evaluate: Function }} page
 * @param {AuthProfile} profile
 * @returns {Promise<{ isAuthenticated: boolean, userId: string, username: string, avatar: string, error: string }>}
 */
export async function checkLogin(page, profile) {
    if (!profile || !profile.home) throw new Error('checkLogin: profile.home is required');
    if (typeof profile.checkAuth !== 'function') throw new Error('checkLogin: profile.checkAuth must be a function');
    // 未登录时鉴权页通常会被重定向到登录页，gotoWritePage 落不到目标源会抛错。
    // 对「登录检测」而言这本身就是答案：到不了鉴权页 = 未登录。干净返回，别把导航异常
    // 当成 whoami 的报错往外冒（否则用户看到的是「停在空白页」而非「未登录」）。
    try {
        await gotoWritePage(page, profile.home, profile.originRe);
    } catch (e) {
        return {
            isAuthenticated: false, userId: '', username: '', avatar: '',
            error: '未登录（无法进入需登录的页面，疑似被重定向到登录页）',
        };
    }
    const js = buildCheckAuthJs(profile.checkAuth.toString());
    const r = await page.evaluate(js);
    return r || { isAuthenticated: false, userId: '', username: '', avatar: '', error: 'no result' };
}

/**
 * 发布前的登录前置：未登录直接抛 typed error。
 * @param {object} page
 * @param {AuthProfile} profile
 * @param {string} siteLabel  平台展示名（用于报错文案）
 */
export async function requireLogin(page, profile, siteLabel) {
    const r = await checkLogin(page, profile);
    if (!r.isAuthenticated) {
        throw new CommandExecutionError(
            `未登录${siteLabel || ''}。请先在已连接 opencli 浏览器桥的 Chrome 里登录该平台。`
            + (r.error ? `（${r.error}）` : ''),
        );
    }
    return r;
}

export const __test__ = {
    buildCheckAuthJs,
    checkLogin,
    requireLogin,
};
