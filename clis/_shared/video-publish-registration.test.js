import { describe, expect, it } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import '../kuaishou/auth.js';
import '../kuaishou/publish.js';
import '../tiktok/publish.js';
import '../youtube/publish.js';
import '../baijiahao/publish.js';
import '../bilibili/publish.js';

function find(site, name) {
  return [...getRegistry().values()].find((c) => c.site === site && c.name === name);
}

describe('video publish adapters registration', () => {
  it('registers kuaishou login + publish', () => {
    expect(find('kuaishou', 'login')).toBeDefined();
    const cmd = find('kuaishou', 'publish');
    expect(cmd).toBeDefined();
    expect(cmd.access).toBe('write');
    const argNames = cmd.args.map((a) => a.name);
    expect(argNames).toEqual(expect.arrayContaining(['video', 'title', 'desc', 'tags', 'cover', 'schedule']));
  });

  it('registers tiktok publish', () => {
    const cmd = find('tiktok', 'publish');
    expect(cmd).toBeDefined();
    expect(cmd.args.map((a) => a.name)).toEqual(expect.arrayContaining(['video', 'title', 'tags', 'schedule']));
  });

  it('registers youtube publish with visibility choices', () => {
    const cmd = find('youtube', 'publish');
    expect(cmd).toBeDefined();
    const vis = cmd.args.find((a) => a.name === 'visibility');
    expect(vis.choices).toEqual(['public', 'unlisted', 'private']);
  });

  it('registers baijiahao publish', () => {
    const cmd = find('baijiahao', 'publish');
    expect(cmd).toBeDefined();
    expect(cmd.args.map((a) => a.name)).toEqual(expect.arrayContaining(['video', 'title', 'schedule']));
  });

  it('registers bilibili publish (non-browser) + biliup-login', () => {
    const cmd = find('bilibili', 'publish');
    expect(cmd).toBeDefined();
    expect(cmd.browser).toBe(false);
    expect(cmd.args.map((a) => a.name)).toEqual(expect.arrayContaining(['video', 'title', 'tid', 'tags', 'schedule']));
    expect(find('bilibili', 'biliup-login')).toBeDefined();
  });
});
