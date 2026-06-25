import { CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { buildResultRow, requireExecute, resolvePayload } from './write-shared.js';

cli({
    site: 'zhihu',
    name: 'article',
    access: 'write',
    description: 'Publish a Zhihu article (文章/专栏)',
    domain: 'zhuanlan.zhihu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'title', positional: true, required: true, help: 'Article title' },
        { name: 'text', positional: true, help: 'Article body (plain text by default; pass --html for raw HTML)' },
        { name: 'file', help: 'Article body file path (UTF-8)' },
        { name: 'html', type: 'boolean', help: 'Treat body as raw HTML (default: plain text — escaped, newlines become paragraphs)' },
        { name: 'draft', type: 'boolean', help: 'Save as draft only; do not publish' },
        { name: 'execute', type: 'boolean', help: 'Actually create/publish. Without it the command refuses to write.' },
    ],
    columns: ['status', 'outcome', 'message', 'target_type', 'target', 'created_target', 'created_url'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('Browser session required for zhihu article');
        requireExecute(kwargs);
        const title = String(kwargs.title ?? '').trim();
        if (!title)
            throw new CliError('INVALID_INPUT', 'Article title cannot be empty');
        const body = await resolvePayload(kwargs);
        // Plain text by default (escaped, one <p> per line). Pass --html to send raw HTML.
        const content = kwargs.html
            ? body
            : body.split('\n').map(line => `<p>${escapeHtml(line)}</p>`).join('');
        const draftOnly = Boolean(kwargs.draft);

        // Fetch from the zhuanlan origin so Origin/Referer match the write surface.
        // goto occasionally returns before the navigation lands (page still on a
        // data: URL), which breaks the cookie/xsrf read — retry until we're on zhihu.
        await gotoZhuanlan(page);

        const result = await page.evaluate(`(async () => {
            var title = ${JSON.stringify(title)};
            var content = ${JSON.stringify(content)};
            var draftOnly = ${JSON.stringify(draftOnly)};
            var xsrf = (document.cookie.match(/_xsrf=([^;]+)/) || [])[1] || '';
            var H = { 'Content-Type': 'application/json', 'x-requested-with': 'fetch', 'x-xsrftoken': xsrf };
            var base = 'https://zhuanlan.zhihu.com/api/articles';

            // 1) create an empty draft
            var cr = await fetch(base + '/drafts', {
                method: 'POST', credentials: 'include', headers: H,
                body: JSON.stringify({ title: title }),
            });
            var crText = await cr.text();
            var crData; try { crData = JSON.parse(crText); } catch (e) { crData = null; }
            if (!cr.ok || !crData || !crData.id) {
                return { ok: false, stage: 'create', status: cr.status, message: crText.slice(0, 300) };
            }
            var id = String(crData.id);

            // 2) write title + content into the draft
            var up = await fetch(base + '/' + id + '/draft', {
                method: 'PATCH', credentials: 'include', headers: H,
                body: JSON.stringify({ title: title, content: content, table_of_contents: false, delta_time: 30 }),
            });
            var upText = await up.text();
            if (!up.ok) {
                return { ok: false, stage: 'update', status: up.status, message: upText.slice(0, 300), id: id };
            }

            if (draftOnly) {
                return { ok: true, draft: true, id: id, url: 'https://zhuanlan.zhihu.com/p/' + id + '/edit' };
            }

            // 3) publish
            var pub = await fetch(base + '/' + id + '/publish', {
                method: 'PUT', credentials: 'include', headers: H,
                body: JSON.stringify({}),
            });
            var pubText = await pub.text();
            var pubData; try { pubData = JSON.parse(pubText); } catch (e) { pubData = null; }
            if (!pub.ok) {
                return { ok: false, stage: 'publish', status: pub.status, message: pubText.slice(0, 300), id: id };
            }
            return { ok: true, draft: false, id: id, url: (pubData && pubData.url) || ('https://zhuanlan.zhihu.com/p/' + id) };
        })()`);

        if (!result?.ok) {
            throw new CliError('COMMAND_EXEC', `[${result?.stage}] ${result?.message || 'Failed to publish article'} (HTTP ${result?.status})`);
        }
        return buildResultRow(
            result.draft ? 'Saved article draft' : 'Published article',
            'article',
            '',
            result.draft ? 'draft' : 'created',
            { created_target: 'article:' + result.id, created_url: result.url },
        );
    },
});

async function gotoZhuanlan(page) {
    for (let i = 0; i < 4; i++) {
        await page.goto('https://zhuanlan.zhihu.com');
        await page.wait(3);
        const href = await page.evaluate('location.href');
        if (typeof href === 'string' && /^https?:\/\/[^/]*zhihu\.com/.test(href)) {
            return;
        }
    }
    throw new CommandExecutionError('Failed to navigate to zhuanlan.zhihu.com (page did not land on a zhihu origin)');
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
