/**
 * Ghost Admin API — shared config + JWT auth + authenticated request helper.
 *
 * Ghost authenticates the Admin API with a short-lived JWT signed from an
 * Admin API key. The key (created at Ghost Admin → Settings → Integrations →
 * add custom integration) is `id:secret`, where `secret` is hex-encoded and
 * must be decoded to raw bytes before use as the HMAC key — passing the hex
 * string produces a valid-looking but rejected signature. Tokens must expire
 * within 5 minutes. We sign with node:crypto (no extra dependency).
 *
 * Connection is carried by env vars (injected by the PublishPort desktop "连接"
 * store at call time; never persisted to disk here):
 *   GHOST_ADMIN_URL  e.g. https://example.com (the site root, no trailing /ghost)
 *   GHOST_ADMIN_KEY  the Admin API key, i.e. "<id>:<hex-secret>"
 */
import { createHmac } from 'node:crypto';
import { CliError } from '@jackwener/opencli/errors';

function normalizeBaseUrl(raw, label) {
    const value = raw?.trim().replace(/\/+$/, '');
    if (!value) {
        throw new CliError('CONFIG', `Missing ${label}`, `Set ${label}, e.g. https://your-site.com (your Ghost site root URL).`);
    }
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new CliError('CONFIG', `Invalid ${label}: ${value}`, 'Use an absolute http(s) URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new CliError('CONFIG', `Invalid ${label}: ${value}`, 'Use an http(s) URL.');
    }
    return value;
}

/** Read Ghost connection config from env. Throws CliError('CONFIG') if incomplete/malformed. */
export function getGhostConfig(env = process.env) {
    const baseUrl = normalizeBaseUrl(env.GHOST_ADMIN_URL, 'GHOST_ADMIN_URL');
    const key = env.GHOST_ADMIN_KEY?.trim();
    if (!key) {
        throw new CliError('CONFIG', 'Ghost Admin API key missing', 'Set GHOST_ADMIN_KEY to your Admin API key (Ghost Admin → Settings → Integrations → add custom integration). Format: <id>:<secret>.');
    }
    const [id, secret] = key.split(':');
    if (!id || !secret || !/^[0-9a-fA-F]+$/.test(secret)) {
        throw new CliError('CONFIG', 'Malformed GHOST_ADMIN_KEY', 'Expected "<id>:<hex-secret>" — copy the full Admin API key, not the Content API key.');
    }
    return { baseUrl, keyId: id, secret };
}

function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Sign a short-lived (5 min) Ghost Admin JWT. Exported for testing. */
export function signGhostToken(config, nowSec = Math.floor(Date.now() / 1000)) {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: config.keyId }));
    const payload = base64url(JSON.stringify({ iat: nowSec, exp: nowSec + 5 * 60, aud: '/admin/' }));
    const data = `${header}.${payload}`;
    const sig = createHmac('sha256', Buffer.from(config.secret, 'hex')).update(data).digest();
    return `${data}.${base64url(sig)}`;
}

/**
 * Authenticated request to the Ghost Admin API (under <baseUrl>/ghost/api/admin).
 * Returns parsed JSON, or throws a typed CliError mapping the HTTP status.
 */
export async function ghostRequest(config, apiPath, options = {}) {
    const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    const url = `${config.baseUrl}/ghost/api/admin${path}`;
    const label = options.label || `Ghost ${options.method || 'GET'} ${path}`;
    let resp;
    try {
        resp = await fetch(url, {
            method: options.method || 'GET',
            headers: {
                Authorization: `Ghost ${signGhostToken(config)}`,
                Accept: 'application/json',
                'Accept-Version': 'v5.0',
                ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...(options.headers || {}),
            },
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
    } catch (e) {
        throw new CliError('FETCH_ERROR', `${label} failed: ${e?.message ?? e}`, 'Check the site URL is reachable and that it is a Ghost site.');
    }
    const text = await resp.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }
    if (resp.status === 401 || resp.status === 403) {
        throw new CliError('AUTH_REQUIRED', `${label} returned HTTP ${resp.status} (unauthorized)`, 'Check GHOST_ADMIN_URL / GHOST_ADMIN_KEY — use the Admin API key (not Content API), and make sure the integration is enabled.');
    }
    if (resp.status === 404) {
        throw new CliError('NOT_FOUND', `${label} returned HTTP 404`, 'Check the site URL points at a Ghost site (the Admin API lives under /ghost/api/admin).');
    }
    if (!resp.ok) {
        const firstError = Array.isArray(parsed?.errors) && parsed.errors[0]?.message ? `: ${parsed.errors[0].message}` : resp.statusText ? `: ${resp.statusText}` : '';
        throw new CliError('HTTP_ERROR', `${label} returned HTTP ${resp.status}${firstError}`);
    }
    return parsed;
}
