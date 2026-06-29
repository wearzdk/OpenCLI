/**
 * WordPress REST API — shared config + authenticated request helper.
 *
 * Auth model is deliberately the simplest WordPress offers: an Application
 * Password (built into WordPress since 5.6) sent via HTTP Basic auth. The user
 * creates one at wp-admin → Users → Profile → Application Passwords, then the
 * PublishPort desktop "连接" store keeps it locally and injects it into this
 * command's environment at call time. We never persist the secret to disk here.
 *
 * Connection is carried entirely by env vars (same pattern as the jira/ones
 * adapters), so the adapter stays a thin, browserless LOCAL command:
 *   WORDPRESS_BASE_URL      e.g. https://example.com (the site root)
 *   WORDPRESS_USER          the WordPress username
 *   WORDPRESS_APP_PASSWORD  an Application Password (spaces are stripped)
 */
import { CliError } from '@jackwener/opencli/errors';

function normalizeBaseUrl(raw, label) {
    const value = raw?.trim().replace(/\/+$/, '');
    if (!value) {
        throw new CliError('CONFIG', `Missing ${label}`, `Set ${label}, e.g. https://your-site.com (your WordPress site root URL).`);
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

/** Read WordPress connection config from env. Throws CliError('CONFIG') if incomplete. */
export function getWordpressConfig(env = process.env) {
    const baseUrl = normalizeBaseUrl(env.WORDPRESS_BASE_URL, 'WORDPRESS_BASE_URL');
    const user = env.WORDPRESS_USER?.trim();
    // Application Passwords are shown with spaces for readability (e.g. "abcd efgh ...");
    // they are accepted with or without spaces, so strip them to be forgiving.
    const appPassword = env.WORDPRESS_APP_PASSWORD?.replace(/\s+/g, '');
    if (!user || !appPassword) {
        throw new CliError('CONFIG', 'WordPress credentials missing', 'Set WORDPRESS_USER and WORDPRESS_APP_PASSWORD. Create an Application Password at wp-admin → Users → Profile → Application Passwords.');
    }
    return { baseUrl, user, appPassword };
}

function authHeader(config) {
    const token = Buffer.from(`${config.user}:${config.appPassword}`, 'utf8').toString('base64');
    return `Basic ${token}`;
}

/**
 * Authenticated request to the WordPress REST API (under <baseUrl>/wp-json).
 * Returns parsed JSON, or throws a typed CliError mapping the HTTP status to a
 * clear, actionable hint.
 */
export async function wpRequest(config, apiPath, options = {}) {
    const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    const url = `${config.baseUrl}/wp-json${path}`;
    const label = options.label || `WordPress ${options.method || 'GET'} ${path}`;
    let resp;
    try {
        resp = await fetch(url, {
            method: options.method || 'GET',
            headers: {
                Authorization: authHeader(config),
                Accept: 'application/json',
                ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...(options.headers || {}),
            },
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
    } catch (e) {
        throw new CliError('FETCH_ERROR', `${label} failed: ${e?.message ?? e}`, 'Check the site URL is reachable and the REST API (/wp-json) is enabled.');
    }
    const text = await resp.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }
    if (resp.status === 401 || resp.status === 403) {
        throw new CliError('AUTH_REQUIRED', `${label} returned HTTP ${resp.status} (unauthorized)`, 'Check WORDPRESS_USER / WORDPRESS_APP_PASSWORD — the Application Password must belong to that user and not be revoked.');
    }
    if (resp.status === 404) {
        throw new CliError('NOT_FOUND', `${label} returned HTTP 404`, 'Check the site URL and that the WordPress REST API is enabled (some hosts/security plugins disable /wp-json).');
    }
    if (!resp.ok) {
        const detail = parsed?.message ? `: ${parsed.message}` : resp.statusText ? `: ${resp.statusText}` : '';
        throw new CliError('HTTP_ERROR', `${label} returned HTTP ${resp.status}${detail}`);
    }
    return parsed;
}
