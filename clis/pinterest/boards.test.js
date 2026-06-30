import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import './boards.js';

function makePage(evaluateResults = []) {
  const queue = [...evaluateResults];
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    getCookies: vi.fn().mockResolvedValue([{ name: 'csrftoken', value: 'tok' }]),
    evaluate: vi.fn(async () => (queue.length ? queue.shift() : null)),
  };
}
const resource = (data) => ({ ok: true, status: 200, data: { resource_response: { data } }, text: '' });

describe('pinterest boards commands', () => {
  it('lists boards as id/name/url rows', async () => {
    const page = makePage(['alice', resource([{ id: 'b1', name: 'Inspiration', url: '/alice/inspiration/' }])]);
    const rows = await getRegistry().get('pinterest/boards').func(page, {});
    expect(rows).toEqual([{ id: 'b1', name: 'Inspiration', url: 'https://www.pinterest.com/alice/inspiration/' }]);
  });

  it('creates a board and returns its row', async () => {
    const page = makePage(['alice', resource({ id: 'nb', name: 'New', url: '/alice/new/' })]);
    const row = await getRegistry().get('pinterest/board-create').func(page, { name: 'New' });
    expect(row).toEqual({ id: 'nb', name: 'New', url: 'https://www.pinterest.com/alice/new/' });
  });

  it('rejects an empty board name', async () => {
    const page = makePage();
    await expect(getRegistry().get('pinterest/board-create').func(page, { name: '  ' })).rejects.toBeInstanceOf(ArgumentError);
  });
});
