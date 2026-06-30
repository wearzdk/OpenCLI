/**
 * Pinterest boards — list boards (read) and create a board (write).
 * Pins must target a board, so this is a required dependency atom for `pin`.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { buildBoardsOptions, buildCreateBoardOptions, csrfTokenFromCookies } from './api.js';
import { pinGet, pinCreate, resolvePinterestUser } from './client.js';

function boardRow(b, fallbackName) {
  return {
    id: String(b?.id ?? ''),
    name: b?.name ?? fallbackName ?? '',
    url: b?.url ? `https://www.pinterest.com${b.url}` : '',
  };
}

cli({
  site: 'pinterest',
  name: 'boards',
  access: 'read',
  description: 'List your Pinterest boards',
  domain: 'www.pinterest.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [],
  columns: ['id', 'name', 'url'],
  func: async (page) => {
    if (!page) throw new CommandExecutionError('Browser session required for pinterest boards');
    const username = await resolvePinterestUser(page);
    const data = await pinGet(page, { resource: 'BoardsResource', sourceUrl: `/${username}/boards/`, options: buildBoardsOptions(username), label: 'boards' });
    return (Array.isArray(data) ? data : []).map((b) => boardRow(b));
  },
});

cli({
  site: 'pinterest',
  name: 'board-create',
  access: 'write',
  description: 'Create a new Pinterest board',
  domain: 'www.pinterest.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'name', type: 'string', required: true, positional: true, help: 'Board name' },
    { name: 'description', type: 'string', help: 'Board description' },
    { name: 'privacy', type: 'string', default: 'public', help: 'public | secret' },
  ],
  columns: ['id', 'name', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for pinterest board-create');
    const name = String(kwargs.name ?? '').trim();
    if (!name) throw new ArgumentError('board name is required');
    const username = await resolvePinterestUser(page);
    const csrf = csrfTokenFromCookies(await page.getCookies({ url: 'https://www.pinterest.com' }));
    const data = await pinCreate(page, {
      resource: 'BoardResource', sourceUrl: `/${username}/boards/`,
      options: buildCreateBoardOptions(name, { description: kwargs.description, privacy: kwargs.privacy }),
      csrf, label: 'board-create',
    });
    return boardRow(data, name);
  },
});
