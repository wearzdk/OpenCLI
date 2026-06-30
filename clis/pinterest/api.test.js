import { describe, expect, it } from 'vitest';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import {
  pinUrlEncode, encodeResourceBody, csrfTokenFromCookies, writeHeaders, parseResourceData,
  buildBoardsOptions, buildCreateBoardOptions, selectBoardByName, buildPinOptions,
} from './api.js';

describe('pinterest api wire format', () => {
  it('encodes spaces as %20, never +', () => {
    expect(pinUrlEncode('a b')).toBe('a%20b');
  });
  it('builds the source_url/data/_ triple with %20-encoded spaces', () => {
    const body = encodeResourceBody({ options: { name: 'My Board' }, sourceUrl: '/alice/boards/' }, 1700000000000);
    expect(body).toContain('source_url=%2Falice%2Fboards%2F');
    expect(body).toContain('_=1700000000000');
    // data is JSON({options,context:null}) then url-encoded; spaces → %20, no '+'
    expect(body).toContain('data=');
    expect(body).not.toContain('+');
    const data = decodeURIComponent(body.split('data=')[1].split('&')[0]);
    expect(JSON.parse(data)).toEqual({ options: { name: 'My Board' }, context: null });
  });
  it('reads csrftoken from cookies and echoes it into the write header', () => {
    expect(csrfTokenFromCookies([{ name: '_pinterest_sess', value: 's' }, { name: 'csrftoken', value: 'TOK' }])).toBe('TOK');
    expect(csrfTokenFromCookies([])).toBe('');
    expect(writeHeaders('TOK')).toMatchObject({ 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': 'TOK' });
    expect(writeHeaders('')).not.toHaveProperty('X-CSRFToken');
  });
});

describe('pinterest parseResourceData', () => {
  it('returns resource_response.data', () => {
    expect(parseResourceData({ resource_response: { data: { id: '1' } } }, 'pin')).toEqual({ id: '1' });
    expect(parseResourceData({ resource_response: { data: [] } }, 'boards')).toEqual([]);
  });
  it('throws on an error envelope', () => {
    expect(() => parseResourceData({ resource_response: { error: 'bad' } }, 'pin')).toThrow(CommandExecutionError);
    expect(() => parseResourceData({}, 'pin')).toThrow(CommandExecutionError);
  });
});

describe('pinterest board + pin options', () => {
  it('builds boards listing options', () => {
    expect(buildBoardsOptions('alice')).toMatchObject({ username: 'alice', page_size: 50, field_set_key: 'profile_grid_item' });
  });
  it('builds create-board options with privacy mapping', () => {
    expect(buildCreateBoardOptions('B', {})).toMatchObject({ name: 'B', privacy: 'public', layout: 'default', category: 'other' });
    expect(buildCreateBoardOptions('B', { privacy: 'secret' }).privacy).toBe('secret');
    expect(buildCreateBoardOptions('B', { privacy: 'private' }).privacy).toBe('secret');
  });
  it('selects a board by name case-insensitively', () => {
    const boards = [{ id: '1', name: 'Inspiration' }, { id: '2', name: 'Recipes' }];
    expect(selectBoardByName(boards, 'recipes')).toEqual({ id: '2', name: 'Recipes' });
    expect(selectBoardByName(boards, 'missing')).toBeNull();
  });
  it('builds pin options with link falling back to image_url', () => {
    const withLink = buildPinOptions({ boardId: '1', imageUrl: 'https://img/x.jpg', title: 'T', link: 'https://land' });
    expect(withLink).toMatchObject({ board_id: '1', image_url: 'https://img/x.jpg', link: 'https://land', method: 'uploaded' });
    const noLink = buildPinOptions({ boardId: '1', imageUrl: 'https://img/x.jpg', title: 'T' });
    expect(noLink.link).toBe('https://img/x.jpg');
  });
});
