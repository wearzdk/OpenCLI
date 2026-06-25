/**
 * Bilibili dynamic-post — publish a text dynamic (动态) via the official web API
 * (/x/dynamic/feed/create/dyn), authenticated by the logged-in cookie + bili_jct CSRF.
 * Text-only for now; image dynamics need a separate bfs upload step (future work).
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

cli({
    site: 'bilibili',
    name: 'dynamic-post',
    access: 'write',
    description: '发布 B站动态（纯文本，官方 API，需登录）',
    domain: 'www.bilibili.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'text', required: true, positional: true, help: 'Dynamic text content' },
        { name: 'execute', type: 'boolean', help: 'Actually publish. Without it the command refuses to write.' },
    ],
    columns: ['status', 'dynamic_id', 'text', 'url'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('Browser session required for bilibili dynamic-post');
        const text = String(kwargs.text ?? '').trim();
        if (!text)
            throw new ArgumentError('bilibili dynamic-post text cannot be empty');
        if (!kwargs.execute)
            throw new ArgumentError('Refusing to post: pass --execute to actually publish this dynamic');

        // goto occasionally returns before the navigation lands (page still on a
        // data: URL), which breaks the cookie/CSRF read — retry until we're on bilibili.
        let landed = false;
        for (let i = 0; i < 4; i++) {
            await page.goto('https://t.bilibili.com');
            await page.wait(2);
            const href = await page.evaluate('location.href');
            if (typeof href === 'string' && /^https?:\/\/[^/]*bilibili\.com/.test(href)) {
                landed = true;
                break;
            }
        }
        if (!landed)
            throw new CommandExecutionError('Failed to navigate to t.bilibili.com (page did not land on a bilibili origin)');

        const result = await page.evaluate(`(async () => {
            var text = ${JSON.stringify(text)};
            var csrf = (document.cookie.match(/bili_jct=([^;]+)/) || [])[1] || '';
            var url = 'https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=' + encodeURIComponent(csrf);
            var body = {
                dyn_req: {
                    content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
                    scene: 1,
                    meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
                },
            };
            var resp = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            var t = await resp.text();
            var data; try { data = JSON.parse(t); } catch (e) { data = null; }
            if (!data) return { ok: false, message: 'Non-JSON response (HTTP ' + resp.status + '): ' + t.slice(0, 250) };
            if (data.code !== 0) return { ok: false, message: (data.message || 'unknown error') + ' (' + data.code + ')' };
            var dynId = data.data && (data.data.dyn_id_str || data.data.dyn_id || data.data.dynamic_id_str);
            return { ok: true, dynId: String(dynId || ''), raw: t.slice(0, 250) };
        })()`);

        if (!result?.ok) {
            throw new CommandExecutionError(`Bilibili dynamic-post failed: ${result?.message || 'unknown error'}`);
        }
        return [{
            status: 'success',
            dynamic_id: result.dynId,
            text,
            url: result.dynId ? `https://t.bilibili.com/${result.dynId}` : '',
        }];
    },
});
