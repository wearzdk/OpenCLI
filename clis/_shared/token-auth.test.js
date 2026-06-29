import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthRequiredError, ArgumentError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import {
  clearCredentials,
  loadCredentials,
  registerTokenAuth,
  requireCredentials,
  saveCredentials,
} from './token-auth.js';

// 把 ~/.opencli 重定向到一次性临时目录，用真实 fs 验证落盘 + 权限。
vi.mock('node:os', async (orig) => {
  const actual = await orig();
  return { ...actual, homedir: () => globalThis.__TOKEN_AUTH_HOME__ };
});

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-auth-'));
  globalThis.__TOKEN_AUTH_HOME__ = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete globalThis.__TOKEN_AUTH_HOME__;
});

describe('credential store', () => {
  it('roundtrips credentials and writes 0600', () => {
    expect(loadCredentials('demo')).toBeNull();
    saveCredentials('demo', { token: 'abc', service: 'https://x' });
    expect(loadCredentials('demo')).toEqual({ token: 'abc', service: 'https://x' });
    const file = path.join(home, '.opencli', 'sites', 'demo', 'credentials.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('requireCredentials throws AuthRequiredError when missing', () => {
    expect(() => requireCredentials('demo')).toThrow(AuthRequiredError);
  });

  it('clearCredentials removes the file', () => {
    saveCredentials('demo', { token: 'abc' });
    expect(clearCredentials('demo')).toBe(true);
    expect(clearCredentials('demo')).toBe(false);
    expect(loadCredentials('demo')).toBeNull();
  });
});

describe('registerTokenAuth', () => {
  const site = 'token-auth-test';
  function register(validate) {
    registerTokenAuth({
      site,
      domain: 'example.com',
      fields: [
        { name: 'token', required: true, help: 'API token' },
        { name: 'service', required: false, default: 'https://example.com' },
      ],
      identityColumns: ['id', 'username'],
      validate,
    });
    return {
      login: getRegistry().get(`${site}/login`),
      whoami: getRegistry().get(`${site}/whoami`),
    };
  }

  it('registers non-browser login + whoami with expected shape', () => {
    const { login, whoami } = register(async () => ({ id: '1', username: 'alice' }));
    expect(whoami).toMatchObject({ access: 'read', browser: false, columns: ['logged_in', 'site', 'id', 'username'] });
    expect(login).toMatchObject({ access: 'write', browser: false, columns: ['status', 'logged_in', 'site', 'id', 'username'] });
  });

  it('login validates, persists, and whoami reads it back', async () => {
    const validate = vi.fn(async (creds) => {
      expect(creds.token).toBe('tok');
      return { id: '42', username: 'bob' };
    });
    const { login, whoami } = register(validate);

    await expect(login.func({ token: 'tok' })).resolves.toMatchObject({
      status: 'login_complete', logged_in: true, site, id: '42', username: 'bob',
    });
    expect(loadCredentials(site)).toEqual({ token: 'tok', service: 'https://example.com' });
    await expect(whoami.func({})).resolves.toMatchObject({ logged_in: true, id: '42', username: 'bob' });
  });

  it('login without required field throws ArgumentError and does not persist', async () => {
    const validate = vi.fn();
    const { login } = register(validate);
    await expect(login.func({ service: 'https://example.com' })).rejects.toThrow(ArgumentError);
    expect(validate).not.toHaveBeenCalled();
    expect(loadCredentials(site)).toBeNull();
  });

  it('login does not persist when validate rejects', async () => {
    const { login } = register(async () => { throw new AuthRequiredError('example.com', 'bad token'); });
    await expect(login.func({ token: 'bad' })).rejects.toThrow(AuthRequiredError);
    expect(loadCredentials(site)).toBeNull();
  });

  it('whoami throws AuthRequiredError when not configured', async () => {
    const { whoami } = register(async () => ({ id: '1' }));
    await expect(whoami.func({})).rejects.toThrow(AuthRequiredError);
  });

  it('login marks status updated when credentials already exist', async () => {
    const { login } = register(async () => ({ id: '1' }));
    await login.func({ token: 'first' });
    await expect(login.func({ token: 'second' })).resolves.toMatchObject({ status: 'updated' });
    expect(loadCredentials(site).token).toBe('second');
  });
});
