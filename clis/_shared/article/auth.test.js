// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { buildCheckAuthJs, checkLogin, requireLogin } from './auth.js';

describe('buildCheckAuthJs', () => {
    it('内联 PAGE_RUNTIME + checkAuth 源码并归一返回字段', () => {
        const js = buildCheckAuthJs('(PP) => ({ isAuthenticated: true })');
        expect(js).toContain('var PP = ');
        expect(js).toContain('__checkAuth(PP)');
        expect(js).toContain('isAuthenticated');
    });
});

function evalPage(fetchImpl) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: async (js) => {
            const pf = globalThis.fetch;
            globalThis.fetch = fetchImpl;
            try {
                // eslint-disable-next-line no-eval
                return await (0, eval)(js);
            } finally {
                globalThis.fetch = pf;
            }
        },
    };
}

const profile = {
    home: 'http://localhost',
    originRe: '.',
    checkAuth: async (PP) => {
        const r = await fetch('https://api.site.com/user/get', { credentials: 'include' });
        const j = JSON.parse(await r.text());
        if (j.data && j.data.user_id) return { isAuthenticated: true, userId: j.data.user_id, username: j.data.user_name, avatar: j.data.avatar };
        return { isAuthenticated: false };
    },
};

describe('checkLogin', () => {
    it('已登录：归一出账号信息', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { user_id: 'u1', user_name: '某工程师', avatar: 'a.png' } }) }));
        const r = await checkLogin(evalPage(fetchImpl), profile);
        expect(r.isAuthenticated).toBe(true);
        expect(r.userId).toBe('u1');
        expect(r.username).toBe('某工程师');
    });

    it('未登录：isAuthenticated=false', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: {} }) }));
        const r = await checkLogin(evalPage(fetchImpl), profile);
        expect(r.isAuthenticated).toBe(false);
    });

    it('鉴权页进不去（疑似被弹去登录页）：干净判未登录，不把导航异常往外抛', async () => {
        // originRe 永不匹配 jsdom 的 location（http://localhost/），模拟「未登录被重定向到登录页」
        const bouncedProfile = { ...profile, originRe: 'https://login\\.never-match\\.com' };
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
        const r = await checkLogin(evalPage(fetchImpl), bouncedProfile);
        expect(r.isAuthenticated).toBe(false);
        expect(r.error).toContain('未登录');
        expect(fetchImpl).not.toHaveBeenCalled(); // 没进鉴权页，checkAuth 不应被执行
    });

    it('requireLogin：未登录抛 typed error', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: {} }) }));
        await expect(requireLogin(evalPage(fetchImpl), profile, '某平台')).rejects.toThrow(/未登录某平台/);
    });
});
