import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { readFileSync } from 'node:fs';
import { normalizeContent } from '../_shared/article/format.js';
import { getGhostConfig, ghostRequest } from './shared.js';

const VALID_STATUS = ['draft', 'published'];

cli({
    site: 'ghost',
    name: 'publish',
    access: 'write',
    description: 'Publish a post to a Ghost site via the Admin API. A Markdown body is converted to HTML automatically (sent with ?source=html). Defaults to a draft for safety — pass --status published to go live.',
    domain: 'ghost.org',
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'title', required: true, help: 'Post title' },
        { name: 'content', help: 'Post body (Markdown or HTML). Or use --file.' },
        { name: 'file', help: 'Read the post body from a local file instead of --content' },
        { name: 'markup', default: 'auto', choices: ['auto', 'markdown', 'html'], help: 'How to interpret the body: auto-detect (default), markdown, or html' },
        { name: 'status', default: 'draft', choices: VALID_STATUS, help: 'Post status (default: draft)' },
        { name: 'excerpt', help: 'Optional custom excerpt' },
        { name: 'slug', help: 'Optional URL slug' },
        { name: 'tags', help: 'Comma-separated tag names (created if missing)' },
    ],
    columns: ['id', 'status', 'title', 'url'],
    func: async (args) => {
        const config = getGhostConfig();
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
        const post = {
            title: String(args.title),
            html,
            status: String(args.status),
        };
        if (args.excerpt) post.custom_excerpt = String(args.excerpt);
        if (args.slug) post.slug = String(args.slug);
        if (args.tags) {
            post.tags = String(args.tags)
                .split(',')
                .map((name) => name.trim())
                .filter(Boolean)
                .map((name) => ({ name }));
        }
        const data = await ghostRequest(config, '/posts/?source=html', {
            method: 'POST',
            body: { posts: [post] },
            label: 'Ghost publish',
        });
        const created = Array.isArray(data?.posts) ? data.posts[0] : undefined;
        if (!created?.id) {
            throw new CliError('PARSE_ERROR', 'Ghost did not return a created post', 'The Admin API response was missing posts[0].id.');
        }
        return [
            {
                id: created.id,
                status: created.status ?? post.status,
                title: created.title ?? post.title,
                url: created.url ?? '',
            },
        ];
    },
});
