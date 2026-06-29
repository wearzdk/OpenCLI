import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { getWordpressConfig, wpRequest } from './shared.js';
import './publish.js';
import './whoami.js';

const ENV_KEYS = ['WORDPRESS_BASE_URL', 'WORDPRESS_USER', 'WORDPRESS_APP_PASSWORD'];

function clearEnv() {
    for (const key of ENV_KEYS) delete process.env[key];
}

function setEnv() {
    process.env.WORDPRESS_BASE_URL = 'https://blog.example.com/';
    process.env.WORDPRESS_USER = 'alice';
    process.env.WORDPRESS_APP_PASSWORD = 'abcd efgh ijkl mnop';
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function publishFunc() {
    return getRegistry().get('wordpress/publish').func;
}

beforeEach(() => {
    clearEnv();
    setEnv();
});

afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
});

describe('getWordpressConfig', () => {
    it('reads + normalizes config from env (strips trailing slash and password spaces)', () => {
        const config = getWordpressConfig();
        expect(config.baseUrl).toBe('https://blog.example.com');
        expect(config.user).toBe('alice');
        expect(config.appPassword).toBe('abcdefghijklmnop');
    });

    it('throws CONFIG when site URL is missing', () => {
        delete process.env.WORDPRESS_BASE_URL;
        expect(() => getWordpressConfig()).toThrowError(/Missing WORDPRESS_BASE_URL/);
    });

    it('throws CONFIG when credentials are missing', () => {
        delete process.env.WORDPRESS_APP_PASSWORD;
        expect(() => getWordpressConfig()).toThrowError(/credentials missing/);
    });

    it('rejects a non-http(s) site URL', () => {
        process.env.WORDPRESS_BASE_URL = 'ftp://blog.example.com';
        expect(() => getWordpressConfig()).toThrowError(/Invalid WORDPRESS_BASE_URL/);
    });
});

describe('wpRequest', () => {
    it('sends Basic auth and hits /wp-json', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
        vi.stubGlobal('fetch', fetchMock);
        await wpRequest(getWordpressConfig(), '/wp/v2/users/me');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://blog.example.com/wp-json/wp/v2/users/me');
        // base64("alice:abcdefghijklmnop")
        const expected = `Basic ${Buffer.from('alice:abcdefghijklmnop').toString('base64')}`;
        expect(init.headers.Authorization).toBe(expected);
    });

    it('maps 401 to an AUTH_REQUIRED CliError', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, 401)));
        await expect(wpRequest(getWordpressConfig(), '/wp/v2/users/me')).rejects.toMatchObject({
            code: 'AUTH_REQUIRED',
        });
    });

    it('maps 404 to a NOT_FOUND CliError', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)));
        await expect(wpRequest(getWordpressConfig(), '/wp/v2/posts')).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });
});

describe('wordpress publish', () => {
    it('converts Markdown to HTML, defaults to draft, and returns the created post', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse({ id: 42, status: 'draft', title: { rendered: 'Hello' }, link: 'https://blog.example.com/?p=42' }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const rows = await publishFunc()({ title: 'Hello', content: '# Hi\n\nsome **bold** text', markup: 'auto', status: 'draft' });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://blog.example.com/wp-json/wp/v2/posts');
        expect(init.method).toBe('POST');
        const sent = JSON.parse(init.body);
        expect(sent.status).toBe('draft');
        expect(sent.title).toBe('Hello');
        expect(sent.content).toContain('<h1>Hi</h1>');
        expect(sent.content).toContain('<strong>bold</strong>');
        expect(rows[0]).toMatchObject({ id: 42, status: 'draft', url: 'https://blog.example.com/?p=42' });
    });

    it('parses comma-separated category/tag IDs and honors --status publish', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 7, status: 'publish', title: { rendered: 'T' }, link: 'u' }));
        vi.stubGlobal('fetch', fetchMock);
        await publishFunc()({ title: 'T', content: 'body', status: 'publish', categories: '3, 5', tags: '9' });
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.status).toBe('publish');
        expect(sent.categories).toEqual([3, 5]);
        expect(sent.tags).toEqual([9]);
    });

    it('rejects an empty body before calling the API', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(publishFunc()({ title: 'T', content: '   ' })).rejects.toMatchObject({ code: 'CONFIG' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
