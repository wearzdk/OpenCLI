import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { parseTweetUrl, buildTwitterArticleScopeSource } from './shared.js';

// The original code ran the ENTIRE delete flow inside ONE long-lived async
// page.evaluate that polled with in-page setTimeout sleeps for up to ~45s. On
// x.com the bridge tab lease gets recycled — the active tab is swapped to
// `data:text/html,<html></html>` — once a command keeps the tab busy with many
// consecutive evaluate/wait round trips for long enough. The monolithic version
// hit this mid-evaluate and failed with "Detached while handling command." A
// naive split into one short evaluate per UI element, each Node-polled 30×500ms,
// still racked up enough round trips during slow polls to trip the same tab
// reset (the tab went blank partway through the "More" poll).
//
// Fix: keep the flow as a few SHORT evaluates, each combining the element lookup
// with its click so a single attempt advances a whole step, and cap the
// per-step poll low (the conversation page is interactive within ~1-2 round
// trips in practice). Selectors / menu-text matching / messages are unchanged.

// Step 1+2 combined: find the target <article>, then find + click the visible
// "More" button inside it. Returns { article: bool, found: bool } so the caller
// can distinguish "tweet card not found" from "More button not found".
//
// The tweet action bar's overflow ("More") button is matched by its stable
// data-testid="caret" FIRST. The previous aria-label === 'More' match was
// locale-dependent: on a Chinese-locale session the label is "更多", so the
// exact-English compare never matched and the whole delete silently failed with
// "Could not find the More context menu". aria-label 'More' is kept only as a
// last-resort fallback for older markup.
function buildFindAndClickMoreScript(tweetId) {
    return `(() => {
        try {
            const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
            ${buildTwitterArticleScopeSource(tweetId)}
            const targetArticle = findTargetArticle();
            if (!targetArticle) return { article: false, found: false };
            let moreMenu = Array.from(targetArticle.querySelectorAll('[data-testid="caret"]')).find(visible);
            if (!moreMenu) {
                const buttons = Array.from(targetArticle.querySelectorAll('button,[role="button"]'));
                moreMenu = buttons.find((el) => visible(el) && (el.getAttribute('aria-label') || '').trim() === 'More');
            }
            if (!moreMenu) return { article: true, found: false };
            moreMenu.click();
            return { article: true, found: true };
        } catch (e) { return { article: false, found: false }; }
    })()`;
}

// Step 3: find + click the "Delete" menu item in the open dropdown.
// Returns { found: bool }.
//
// The Delete menu item carries no stable data-testid, so it must be matched by
// text. The original matched English 'Delete' only and excluded 'List' (the
// "Add/remove from Lists" item). On a Chinese-locale session the items are
// "删除" and "从列表中添加/移除", so the English-only match silently failed.
// Match the localized delete label for English + Chinese, excluding the
// list-management item in either language.
function buildClickDeleteScript() {
    return `(() => {
        try {
            const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
            const deleteBtn = items.find((item) => {
                const text = (item.textContent || '').trim();
                const isList = text.includes('List') || text.includes('列表');
                const isDelete = text.includes('Delete') || text.includes('删除');
                return isDelete && !isList;
            });
            if (!deleteBtn) return { found: false };
            deleteBtn.click();
            return { found: true };
        } catch (e) { return { found: false }; }
    })()`;
}

// Step 4: find + click the confirmation button in the delete sheet.
// Returns { found: bool }.
function buildClickConfirmScript() {
    return `(() => {
        try {
            const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
            if (!confirmBtn) return { found: false };
            confirmBtn.click();
            return { found: true };
        } catch (e) { return { found: false }; }
    })()`;
}
cli({
    site: 'twitter',
    name: 'delete',
    access: 'write',
    description: 'Delete a specific tweet by URL',
    domain: 'x.com',
    strategy: Strategy.UI, // Utilizes internal DOM flows for interaction
    browser: true,
    args: [
        { name: 'url', type: 'string', required: true, positional: true, help: 'The URL of the tweet to delete' },
    ],
    columns: ['status', 'message'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('Browser session required for twitter delete');
        // parseTweetUrl throws ArgumentError on malformed/off-domain inputs —
        // this replaces the ad-hoc local extractTweetId which only checked
        // the path shape and accepted any host (silent: would try to act on
        // attacker-controlled redirect URLs).
        const target = parseTweetUrl(kwargs.url);
        await page.goto(target.url);
        await page.wait({ selector: '[data-testid="primaryColumn"]' }); // Wait for tweet to load completely
        // Bounded poll, Node-driven (not a single long in-page evaluate). Each
        // probe is a short evaluate; page.wait does the sleeping between tries.
        // Keep `tries` modest — the conversation page is interactive within a
        // couple of round trips, and excessive evaluate/wait churn is what trips
        // the bridge's tab-lease reset (blank data:text/html tab) mid-command.
        const pollFor = async (script, predicate, tries = 12) => {
            let last;
            for (let i = 0; i < tries; i++) {
                last = await page.evaluate(script);
                if (predicate(last))
                    return last;
                await page.wait(0.5);
            }
            return last;
        };
        // Steps 1+2: target article hydrates after primaryColumn appears, and the
        // "More" button mounts with it. Combined into one evaluate per attempt so
        // a single round trip advances the whole step (fewer round trips → the
        // tab lease survives). Distinguish "no card" from "no More button".
        const more = await pollFor(buildFindAndClickMoreScript(target.id), (r) => !!(r && r.found));
        if (!more || !more.found) {
            if (more && more.article === false) {
                return [{ status: 'failed', message: 'Could not find the tweet card matching the requested URL.' }];
            }
            return [{ status: 'failed', message: 'Could not find the "More" context menu on the matched tweet. Are you sure you are logged in and looking at a valid tweet?' }];
        }
        // Step 3: the dropdown opens asynchronously after the More click.
        const del = await pollFor(buildClickDeleteScript(), (r) => !!(r && r.found));
        if (!del || !del.found) {
            return [{ status: 'failed', message: 'The matched tweet menu did not contain Delete. This tweet may not belong to you.' }];
        }
        // Step 4: the confirmation sheet renders asynchronously after Delete.
        const confirm = await pollFor(buildClickConfirmScript(), (r) => !!(r && r.found));
        if (!confirm || !confirm.found) {
            return [{ status: 'failed', message: 'Delete confirmation dialog did not appear.' }];
        }
        // Wait for the deletion request to be processed.
        await page.wait(2);
        return [{ status: 'success', message: 'Tweet successfully deleted.' }];
    }
});
export const __test__ = {
    buildFindAndClickMoreScript,
    buildClickDeleteScript,
    buildClickConfirmScript,
};
