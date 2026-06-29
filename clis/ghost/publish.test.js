import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { getRegistry } from '@jackwener/opencli/registry';
import { getGhostConfig, ghostRequest, signGhostToken } from './shared.js';
import './publish.js';
import './whoami.js';

const ENV_KEYS = ['GHOST_ADMIN_URL', 'GHOST_ADMIN_KEY'];
// secret must be valid hex for HMAC signing
const SECRET_HEX = '0123456789abcdef0123456789abcdef';

function clearEnv() {
    for (const key of ENV_KEYS) delete process.env[key];
}

function setEnv() {
    process.env.GHOST_ADMIN_URL = 'https://news.example.com/';
    process.env.GHOST_ADMIN_KEY = `abc123:${SECRET_HEX}`;
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function publishFunc() {
    return getRegistry().get('ghost/publish').func;
}

function decodeJwtPart(part) {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

beforeEach(() => {
    clearEnv();
    setEnv();
});

afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
});

describe('getGhostConfig', () => {
    it('parses id:secret and strips trailing slash', () => {
        const config = getGhostConfig();
        expect(config.baseUrl).toBe('https://news.example.com');
        expect(config.keyId).toBe('abc123');
        expect(config.secret).toBe(SECRET_HEX);
    });

    it('throws CONFIG when key is missing', () => {
        delete process.env.GHOST_ADMIN_KEY;
        expect(() => getGhostConfig()).toThrowError(/Admin API key missing/);
    });

    it('rejects a key whose secret is not hex', () => {
        process.env.GHOST_ADMIN_KEY = 'abc123:not-hex-secret!';
        expect(() => getGhostConfig()).toThrowError(/Malformed GHOST_ADMIN_KEY/);
    });
});

describe('signGhostToken', () => {
    it('signs an HS256 JWT with kid, /admin/ audience, 5-min expiry, hex-decoded secret', () => {
        const config = getGhostConfig();
        const now = 1_700_000_000;
        const token = signGhostToken(config, now);
        const [header, payload, sig] = token.split('.');
        expect(decodeJwtPart(header)).toMatchObject({ alg: 'HS256', typ: 'JWT', kid: 'abc123' });
        expect(decodeJwtPart(payload)).toEqual({ iat: now, exp: now + 300, aud: '/admin/' });
        // signature must use the hex-decoded secret, not the raw hex string
        const expected = createHmac('sha256', Buffer.from(SECRET_HEX, 'hex'))
            .update(`${header}.${payload}`)
            .digest()
            .toString('base64')
            .replace(/=+$/, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
        expect(sig).toBe(expected);
    });
});

describe('ghostRequest', () => {
    it('sends Ghost <jwt> auth against /ghost/api/admin', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ site: {} }));
        vi.stubGlobal('fetch', fetchMock);
        await ghostRequest(getGhostConfig(), '/site/');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://news.example.com/ghost/api/admin/site/');
        expect(init.headers.Authorization).toMatch(/^Ghost [\w-]+\.[\w-]+\.[\w-]+$/);
    });

    it('maps 401 to AUTH_REQUIRED', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'bad key' }] }, 401)));
        await expect(ghostRequest(getGhostConfig(), '/site/')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    });
});

describe('ghost publish', () => {
    it('wraps the post in {posts:[…]}, converts Markdown, defaults to draft', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse({ posts: [{ id: 'p1', status: 'draft', title: 'Hello', url: 'https://news.example.com/p/hello/' }] }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const rows = await publishFunc()({ title: 'Hello', content: '# Hi\n\n**bold**', markup: 'auto', status: 'draft' });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://news.example.com/ghost/api/admin/posts/?source=html');
        const sent = JSON.parse(init.body);
        expect(sent.posts).toHaveLength(1);
        expect(sent.posts[0].status).toBe('draft');
        expect(sent.posts[0].html).toContain('<strong>bold</strong>');
        expect(rows[0]).toMatchObject({ id: 'p1', status: 'draft', url: 'https://news.example.com/p/hello/' });
    });

    it('maps comma-separated tag names to {name} objects', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ posts: [{ id: 'p2', status: 'published', title: 'T', url: 'u' }] }));
        vi.stubGlobal('fetch', fetchMock);
        await publishFunc()({ title: 'T', content: 'body', status: 'published', tags: 'news, tech' });
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.posts[0].tags).toEqual([{ name: 'news' }, { name: 'tech' }]);
    });

    it('rejects an empty body before calling the API', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(publishFunc()({ title: 'T', content: '' })).rejects.toMatchObject({ code: 'CONFIG' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
