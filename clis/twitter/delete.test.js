import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import './delete.js';
describe('twitter delete command', () => {
    it('targets the matched tweet article instead of the first More button on the page', async () => {
        const cmd = getRegistry().get('twitter/delete');
        expect(cmd?.func).toBeTypeOf('function');
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            // The adapter now drives a bounded Node-side poll: each step is a
            // short evaluate (find-More → click-Delete → click-Confirm) whose
            // result is checked for `found`. Returning a value that satisfies
            // `found` on the FIRST probe of every step means no intermediate
            // `wait(0.5)` sleeps fire, so the only wait calls are the initial
            // primaryColumn wait and the final post-delete `wait(2)`.
            evaluate: vi.fn().mockResolvedValue({ article: true, found: true }),
        };
        const result = await cmd.func(page, {
            url: 'https://x.com/alice/status/2040254679301718161?s=20',
        });
        expect(page.goto).toHaveBeenCalledWith('https://x.com/alice/status/2040254679301718161?s=20');
        expect(page.wait).toHaveBeenNthCalledWith(1, { selector: '[data-testid="primaryColumn"]' });
        // All three step probes succeed on the first try (no poll sleeps), so
        // the second wait is still the final post-delete settle wait.
        expect(page.wait).toHaveBeenNthCalledWith(2, 2);
        const script = page.evaluate.mock.calls[0][0];
        // Article-scoping must come from the shared helper (not an inline
        // `pathname.includes('/status/' + tweetId)` substring match — see
        // codex-mini0 #1400 catch where `/status/123` would match
        // `/status/1234567`). The helper emits `__twHasLinkToTarget` and
        // `__twGetStatusIdFromHref` plus the canonical anchored regex.
        expect(script).toContain('__twHasLinkToTarget');
        expect(script).toContain('__twGetStatusIdFromHref');
        expect(script).toContain("document.querySelectorAll('article')");
        expect(script).toContain("targetArticle.querySelectorAll('button,[role=\"button\"]')");
        // Substring match must NOT appear — exact-id match only.
        expect(script).not.toContain("'/status/' + tweetId");
        expect(result).toEqual([
            {
                status: 'success',
                message: 'Tweet successfully deleted.',
            },
        ]);
    });
    it('passes through matched-tweet lookup failures', async () => {
        const cmd = getRegistry().get('twitter/delete');
        expect(cmd?.func).toBeTypeOf('function');
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            // The find-More step reports `article: false` when no <article>
            // matches the requested status id. The bounded poll never sees a
            // `found` result, exhausts its retries, and the adapter maps the
            // final `article === false` outcome to the tweet-card-not-found
            // failure (distinct from the "More button missing" failure).
            evaluate: vi.fn().mockResolvedValue({ article: false, found: false }),
        };
        const result = await cmd.func(page, {
            url: 'https://x.com/alice/status/2040254679301718161',
        });
        expect(result).toEqual([
            {
                status: 'failed',
                message: 'Could not find the tweet card matching the requested URL.',
            },
        ]);
        // The lookup never succeeds, so the find-More step polls to exhaustion:
        // the initial primaryColumn wait plus one inter-attempt sleep per retry.
        expect(page.wait).toHaveBeenCalledTimes(13);
        // Polling must give up at the find-More step — it must NOT proceed to
        // probe the Delete menu item once the tweet card was never found.
        expect(page.evaluate).toHaveBeenCalledTimes(12);
        for (const call of page.evaluate.mock.calls) {
            expect(call[0]).toContain('__twHasLinkToTarget');
        }
    });
    it('rejects malformed or off-domain URLs with ArgumentError before navigation', async () => {
        const cmd = getRegistry().get('twitter/delete');
        expect(cmd?.func).toBeTypeOf('function');
        const page = {
            goto: vi.fn(),
            wait: vi.fn(),
            evaluate: vi.fn(),
        };
        // parseTweetUrl bubbles ArgumentError directly (no CommandExecutionError
        // wrapping); replaces the previous local extractTweetId path that hid
        // typed-input failures behind a generic CliError.
        await expect(cmd.func(page, {
            url: 'https://x.com/alice/home',
        })).rejects.toThrow(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.wait).not.toHaveBeenCalled();
        expect(page.evaluate).not.toHaveBeenCalled();
    });
    it('throws CommandExecutionError when no page is provided', async () => {
        const cmd = getRegistry().get('twitter/delete');
        await expect(cmd.func(undefined, {
            url: 'https://x.com/alice/status/2040254679301718161',
        })).rejects.toThrow(CommandExecutionError);
    });
});
