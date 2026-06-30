import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import './publish.js';

function makePage(evaluateResults = []) {
  const queue = [...evaluateResults];
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    getCookies: vi.fn().mockResolvedValue([{ name: 'XSRF-TOKEN', value: 'tok' }, { name: '_note_session_v5', value: 's' }]),
    evaluate: vi.fn(async () => (queue.length ? queue.shift() : { ok: true, status: 200, data: {}, text: '' })),
  };
}
const res = (data, ok = true, status = 200) => ({ ok, status, data, text: '' });

describe('note publish command', () => {
  const cmd = () => getRegistry().get('note/publish');

  it('publishes a text note and returns the public url', async () => {
    const page = makePage([
      res({ data: { urlname: 'alice' } }),               // current_user
      res({ data: { id: 555, key: 'nKEY' } }),           // create draft
      res({}),                                           // draft_save
      res({ data: { note_key: 'nKEY', public_url: 'https://note.com/alice/n/nKEY' } }), // publish
    ]);
    const result = await cmd().func(page, { title: 'タイトル', body: '本文', tags: 'AI,opencli', magazine: '12345' });
    expect(result).toEqual({ status: 'published', note_key: 'nKEY', url: 'https://note.com/alice/n/nKEY' });
    const publishCall = page.evaluate.mock.calls.at(-1)[0];
    expect(publishCall).toContain('text_notes/555');
    expect(publishCall).toContain('published');
    expect(publishCall).toContain('#AI');
    expect(publishCall).toContain('12345');
  });

  it('stops at draft with --draft', async () => {
    const page = makePage([res({ data: { urlname: 'alice' } }), res({ data: { id: 7, key: 'nK' } }), res({})]);
    const result = await cmd().func(page, { title: 'D', body: 'x', draft: true });
    expect(result).toMatchObject({ status: 'draft', note_key: 'nK' });
    expect(page.evaluate).toHaveBeenCalledTimes(3); // current_user, create, draft_save — no publish
  });

  it('maps anonymous session to AuthRequiredError', async () => {
    const page = makePage([res(null, false, 403)]);
    await expect(cmd().func(page, { title: 'T' })).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('validates title and magazine ids before navigating', async () => {
    const page = makePage();
    await expect(cmd().func(page, { title: '  ' })).rejects.toBeInstanceOf(ArgumentError);
    await expect(cmd().func(page, { title: 'T', magazine: 'nope' })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('throws when create-draft fails', async () => {
    const page = makePage([res({ data: { urlname: 'alice' } }), res(null, false, 500)]);
    await expect(cmd().func(page, { title: 'T', body: 'x' })).rejects.toBeInstanceOf(CommandExecutionError);
  });
});
