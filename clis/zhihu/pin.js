import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { buildResultRow, requireExecute, resolveCurrentUserIdentity, resolvePayload } from './write-shared.js';

cli({
    site: 'zhihu',
    name: 'pin',
    access: 'write',
    description: 'Publish a Zhihu pin (想法/short post)',
    domain: 'www.zhihu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'text', positional: true, help: 'Pin text content' },
        { name: 'file', help: 'Pin text file path (UTF-8)' },
        { name: 'execute', type: 'boolean', help: 'Actually publish the pin. Without it the command refuses to write.' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url', 'author_identity'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('Browser session required for zhihu pin');
        requireExecute(kwargs);
        const payload = await resolvePayload(kwargs);
        await page.goto('https://www.zhihu.com');
        await page.wait(3);
        // Identity is only used to annotate the result row; the create API itself
        // enforces login, so a flaky DOM/state probe must not block the write.
        let authorIdentity = '';
        try {
            authorIdentity = await resolveCurrentUserIdentity(page);
        }
        catch {
            // best-effort
        }
        // Zhihu pins store text as HTML; wrap each line in <p> so line breaks survive.
        const html = payload
            .split('\n')
            .map(line => `<p>${escapeHtml(line)}</p>`)
            .join('');
        const apiResult = await page.evaluate(`(async () => {
            var html = ${JSON.stringify(html)};
            var xsrf = (document.cookie.match(/_xsrf=([^;]+)/) || [])[1] || '';
            var body = new URLSearchParams();
            body.set('content', JSON.stringify([{ type: 'text', content: html }]));
            body.set('reaction_instruction', JSON.stringify({}));
            var resp = await fetch('https://www.zhihu.com/api/v4/pins', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'x-requested-with': 'fetch',
                    'x-xsrftoken': xsrf,
                },
                body: body.toString(),
            });
            var text = await resp.text();
            var data;
            try { data = JSON.parse(text); } catch (e) { data = null; }
            if (!resp.ok) return { ok: false, status: resp.status, message: (data && data.error && data.error.message) || text.slice(0, 300) };
            if (!data || !data.id) return { ok: false, status: resp.status, message: 'Pin API response did not include a created pin id: ' + text.slice(0, 300) };
            return { ok: true, id: String(data.id), url: data.url || ('https://www.zhihu.com/pin/' + data.id) };
        })()`);
        if (!apiResult?.ok) {
            throw new CliError('COMMAND_EXEC', apiResult?.message || 'Failed to publish pin');
        }
        return buildResultRow('Published pin', 'pin', '', 'created', {
            created_target: 'pin:' + apiResult.id,
            created_url: apiResult.url,
            author_identity: authorIdentity,
        });
    },
});

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
