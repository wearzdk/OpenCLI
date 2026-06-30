import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError } from '@jackwener/opencli/errors';
import './publish.js';

// page.goto + queued page.evaluate results, in call order.
function makePage(evaluateResults = []) {
  const queue = [...evaluateResults];
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    getCookies: vi.fn().mockResolvedValue([{ name: 'csrftoken', value: 'tok' }, { name: '_pinterest_sess', value: 's' }]),
    evaluate: vi.fn(async () => (queue.length ? queue.shift() : null)),
  };
}
const resource = (data, ok = true, status = 200) => ({ ok, status, data: { resource_response: { data } }, text: '' });
const boards = [{ id: 'b1', name: 'Inspiration', url: '/alice/inspiration/' }];

describe('pinterest pin command', () => {
  const cmd = () => getRegistry().get('pinterest/pin');

  it('creates a pin on a matched board and returns the pin url', async () => {
    const page = makePage(['alice', resource(boards), resource({ id: '999' })]);
    const result = await cmd().func(page, { title: 'My pin', 'image-url': 'https://img/x.jpg', board: 'inspiration' });
    expect(result).toEqual({ status: 'published', pin_id: '999', url: 'https://www.pinterest.com/pin/999/' });
    const pinCall = page.evaluate.mock.calls.at(-1)[0];
    expect(pinCall).toContain('PinResource/create');
  });

  it('rejects an unknown board with ArgumentError', async () => {
    const page = makePage(['alice', resource(boards)]);
    await expect(cmd().func(page, { title: 'p', 'image-url': 'https://img/x.jpg', board: 'Nope' })).rejects.toBeInstanceOf(ArgumentError);
  });

  it('maps an anonymous session to AuthRequiredError', async () => {
    const page = makePage([null]); // resolvePinterestUser gets no username
    await expect(cmd().func(page, { title: 'p', 'image-url': 'https://img/x.jpg', board: 'Inspiration' })).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('validates required args before any navigation', async () => {
    const page = makePage();
    await expect(cmd().func(page, { title: '  ', 'image-url': 'u', board: 'b' })).rejects.toBeInstanceOf(ArgumentError);
    await expect(cmd().func(page, { title: 't', board: 'b' })).rejects.toBeInstanceOf(ArgumentError); // no image
    await expect(cmd().func(page, { title: 't', 'image-url': 'u' })).rejects.toBeInstanceOf(ArgumentError); // no board
    expect(page.goto).not.toHaveBeenCalled();
  });
});
