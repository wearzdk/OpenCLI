import { describe, expect, it } from 'vitest';
import { ArgumentError } from '@jackwener/opencli/errors';
import {
  xsrfTokenFromCookies, noteWriteHeaders, textToParagraphs, buildBodyHtml, bodyLength,
  parseHashtags, parseMagazineIds, buildDraftSavePayload, buildPublishPayload, publicUrl, classifyImages,
} from './note-utils.js';

describe('note xsrf + headers', () => {
  it('decodes the XSRF-TOKEN cookie into the header value', () => {
    expect(xsrfTokenFromCookies([{ name: 'XSRF-TOKEN', value: 'a%2Bb%3D' }])).toBe('a+b=');
    expect(xsrfTokenFromCookies([{ name: '_note_session_v5', value: 's' }])).toBe('');
  });
  it('builds write headers with the xsrf token', () => {
    expect(noteWriteHeaders('TOK')).toEqual({ 'Content-Type': 'application/json', 'X-XSRF-TOKEN': 'TOK' });
    expect(noteWriteHeaders('')).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('note body html', () => {
  it('splits paragraphs and escapes html', () => {
    expect(textToParagraphs('a\n\nb')).toEqual(['a', 'b']);
    expect(buildBodyHtml(['he<b>llo'], [])).toBe('<p>he&lt;b&gt;llo</p>');
  });
  it('appends figure/img blocks for images', () => {
    expect(buildBodyHtml(['x'], ['https://cdn/a.png'])).toBe('<p>x</p><figure><img src="https://cdn/a.png"></figure>');
  });
  it('body_length is the html char count', () => {
    const html = buildBodyHtml(['hi'], []);
    expect(bodyLength(html)).toBe(html.length);
  });
});

describe('note tags + magazine parsing', () => {
  it('prefixes hashtags with #', () => {
    expect(parseHashtags('AI, #ml ,opencli')).toEqual(['#AI', '#ml', '#opencli']);
    expect(parseHashtags('')).toEqual([]);
  });
  it('parses numeric magazine ids', () => {
    expect(parseMagazineIds('12, 34')).toEqual([12, 34]);
    expect(() => parseMagazineIds('abc')).toThrow(ArgumentError);
  });
});

describe('note payloads', () => {
  it('builds the draft_save payload', () => {
    const p = buildDraftSavePayload({ title: 'T', bodyHtml: '<p>x</p>' });
    expect(p).toMatchObject({ name: 'T', body: '<p>x</p>', body_length: 8, index: false, is_lead_form: false, image_keys: [] });
  });
  it('builds the publish payload as a free note', () => {
    const p = buildPublishPayload({ title: 'T', bodyHtml: '<p>x</p>', hashtags: ['#a'], magazineIds: [5] });
    expect(p).toMatchObject({
      name: 'T', free_body: '<p>x</p>', pay_body: '', status: 'published', price: 0,
      hashtags: ['#a'], magazine_ids: [5], send_notifications_flag: true,
    });
  });
  it('builds the public url', () => {
    expect(publicUrl('alice', 'nABC')).toBe('https://note.com/alice/n/nABC');
  });
});

describe('note classifyImages', () => {
  it('classifies urls vs paths', () => {
    expect(classifyImages('https://x/a.png,/local/b.jpg')).toEqual([
      { kind: 'url', value: 'https://x/a.png' }, { kind: 'path', value: '/local/b.jpg' },
    ]);
  });
});
