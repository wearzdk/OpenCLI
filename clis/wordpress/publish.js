import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { readFileSync } from 'node:fs';
import { normalizeContent } from '../_shared/article/format.js';
import { getWordpressConfig, wpRequest } from './shared.js';

const VALID_STATUS = ['draft', 'publish', 'pending', 'private'];

/** Parse a comma-separated list of numeric term IDs (categories/tags). */
function parseIds(raw) {
    return String(raw)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
}

cli({
    site: 'wordpress',
    name: 'publish',
    access: 'write',
    description: 'Publish a post to a self-hosted WordPress site via the REST API. A Markdown body is converted to HTML automatically. Defaults to a draft for safety — pass --status publish to go live.',
    domain: 'wordpress.org',
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'title', required: true, help: 'Post title' },
        { name: 'content', help: 'Post body (Markdown or HTML). Or use --file.' },
        { name: 'file', help: 'Read the post body from a local file instead of --content' },
        { name: 'markup', default: 'auto', choices: ['auto', 'markdown', 'html'], help: 'How to interpret the body: auto-detect (default), markdown, or html' },
        { name: 'status', default: 'draft', choices: VALID_STATUS, help: 'Post status (default: draft)' },
        { name: 'excerpt', help: 'Optional excerpt / summary' },
        { name: 'slug', help: 'Optional URL slug' },
        { name: 'categories', help: 'Comma-separated category IDs' },
        { name: 'tags', help: 'Comma-separated tag IDs' },
    ],
    columns: ['id', 'status', 'title', 'url'],
    func: async (args) => {
        const config = getWordpressConfig();
        let body = typeof args.content === 'string' ? args.content : '';
        if (args.file) {
            try {
                body = readFileSync(String(args.file), 'utf8');
            } catch (e) {
                throw new CliError('CONFIG', `Cannot read --file ${args.file}: ${e?.message ?? e}`, 'Pass a readable UTF-8 text file.');
            }
        }
        if (!body.trim()) {
            throw new CliError('CONFIG', 'Post body is empty', 'Pass --content "..." or --file <path>.');
        }
        const html = normalizeContent(body, { format: args.markup }).html;
        const payload = {
            title: String(args.title),
            content: html,
            status: String(args.status),
        };
        if (args.excerpt) payload.excerpt = String(args.excerpt);
        if (args.slug) payload.slug = String(args.slug);
        if (args.categories) payload.categories = parseIds(args.categories);
        if (args.tags) payload.tags = parseIds(args.tags);
        const post = await wpRequest(config, '/wp/v2/posts', {
            method: 'POST',
            body: payload,
            label: 'WordPress publish',
        });
        return [
            {
                id: post?.id ?? '',
                status: post?.status ?? '',
                title: post?.title?.rendered ?? payload.title,
                url: post?.link ?? '',
            },
        ];
    },
});
