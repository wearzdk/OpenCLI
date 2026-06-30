import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    statSync: vi.fn((p) => (String(p).includes('missing') ? undefined : { isFile: () => !String(p).includes('dir') })),
    readFileSync: vi.fn(() => Buffer.from('IMG')),
  };
});
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolve: vi.fn((p) => `/abs/${p}`),
    extname: vi.fn((p) => { const m = String(p).match(/\.[^.]+$/); return m ? m[0] : ''; }),
  };
});

import './publish.js';

const PROFILE = { id: 42, publicationUsers: [{ is_primary: true, publication: { subdomain: 'mine', name: 'My Letter' } }] };

// Each pageFetch call does one page.evaluate; queue results in call order.
function makePage(evaluateResults = []) {
  const queue = [...evaluateResults];
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    getCookies: vi.fn().mockResolvedValue([{ name: 'substack.sid', value: 's' }]),
    evaluate: vi.fn(async () => (queue.length ? queue.shift() : { ok: true, status: 200, data: {}, text: '' })),
  };
}
const fetchRes = (data, ok = true, status = 200) => ({ ok, status, data, text: '' });

describe('substack publish command', () => {
  const cmd = () => getRegistry().get('substack/publish');

  it('publishes a text post and returns the canonical url', async () => {
    const page = makePage([
      fetchRes(PROFILE),                 // profile/self
      fetchRes({ id: 1001 }),            // create draft
      fetchRes({}),                      // prepublish
      fetchRes({ slug: 'my-post' }),     // publish
    ]);
    const result = await cmd().func(page, { title: 'Hello', body: 'p1\n\np2', audience: 'everyone' });
    expect(result).toEqual({ status: 'published', publication: 'My Letter', draft_id: '1001', url: 'https://mine.substack.com/p/my-post' });

    // the draft payload posted must carry a JSON-stringified draft_body with both paragraphs
    const draftCall = page.evaluate.mock.calls[1][0];
    expect(draftCall).toContain('/api/v1/drafts');
    expect(draftCall).toContain('draft_body');
    expect(draftCall).toContain('p1');
    expect(draftCall).toContain('p2');
  });

  it('stops at draft with --draft (no prepublish/publish)', async () => {
    const page = makePage([fetchRes(PROFILE), fetchRes({ id: 7 })]);
    const result = await cmd().func(page, { title: 'D', body: 'x', draft: true });
    expect(result).toMatchObject({ status: 'draft', draft_id: '7' });
    // only goto + 2 evaluates (profile, create) — no publish call
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  it('uploads a local image before creating the draft', async () => {
    const page = makePage([
      fetchRes(PROFILE),                              // profile
      fetchRes({ url: 'https://cdn/up.png' }),        // image upload
      fetchRes({ id: 3 }),                            // create draft
      fetchRes({}),                                   // prepublish
      fetchRes({ slug: 's' }),                        // publish
    ]);
    await cmd().func(page, { title: 'T', images: '/pic.png' });
    const uploadCall = page.evaluate.mock.calls[1][0];
    expect(uploadCall).toContain('/api/v1/image');
    expect(uploadCall).toContain('image=');
    const draftCall = page.evaluate.mock.calls[2][0];
    expect(draftCall).toContain('https://cdn/up.png');
    expect(draftCall).toContain('captionedImage');
  });

  it('maps anonymous profile to AuthRequiredError', async () => {
    const page = makePage([fetchRes(null, false, 403)]);
    await expect(cmd().func(page, { title: 'T' })).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('validates title, audience, and image extensions before navigating', async () => {
    const page = makePage();
    await expect(cmd().func(page, { title: '  ' })).rejects.toBeInstanceOf(ArgumentError);
    await expect(cmd().func(page, { title: 'T', audience: 'nope' })).rejects.toBeInstanceOf(ArgumentError);
    await expect(cmd().func(page, { title: 'T', images: '/a.bmp' })).rejects.toBeInstanceOf(ArgumentError);
    await expect(cmd().func(page, { title: 'T', images: '/missing.png' })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('throws when create-draft fails', async () => {
    const page = makePage([fetchRes(PROFILE), fetchRes(null, false, 500)]);
    await expect(cmd().func(page, { title: 'T', body: 'x' })).rejects.toBeInstanceOf(CommandExecutionError);
  });
});
