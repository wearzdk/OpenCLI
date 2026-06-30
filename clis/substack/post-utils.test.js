import { describe, expect, it } from 'vitest';
import { AuthRequiredError, ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  publicationContext, validateAudience, imageDataUri, textToParagraphs, paragraphNode,
  imageBlock, buildDraftBody, buildDraftPayload, collectSections, resolveSectionId, classifyImages,
} from './post-utils.js';

const profile = {
  id: 42,
  publicationUsers: [
    { is_primary: false, publication: { subdomain: 'other', name: 'Other' } },
    { is_primary: true, publication: { subdomain: 'mine', name: 'My Letter' } },
  ],
};

describe('substack publicationContext', () => {
  it('picks the primary publication and builds the substack.com host', () => {
    expect(publicationContext(profile)).toEqual({
      host: 'https://mine.substack.com', userId: 42, publication: 'My Letter', subdomain: 'mine',
    });
  });
  it('uses a real custom domain when present and not optional', () => {
    const ctx = publicationContext({ id: 1, publicationUsers: [{ is_primary: true, publication: { subdomain: 's', custom_domain: 'blog.example.com' } }] });
    expect(ctx.host).toBe('https://blog.example.com');
  });
  it('falls back to subdomain when custom_domain is optional', () => {
    const ctx = publicationContext({ id: 1, publicationUsers: [{ is_primary: true, publication: { subdomain: 's', custom_domain: 'blog.example.com', custom_domain_optional: true } }] });
    expect(ctx.host).toBe('https://s.substack.com');
  });
  it('throws AuthRequiredError without a profile id', () => {
    expect(() => publicationContext({})).toThrow(AuthRequiredError);
  });
  it('throws CommandExecutionError when there is no publication', () => {
    expect(() => publicationContext({ id: 1, publicationUsers: [] })).toThrow(CommandExecutionError);
  });
});

describe('substack pure builders', () => {
  it('validates audience', () => {
    expect(validateAudience(undefined)).toBe('everyone');
    expect(validateAudience('only_paid')).toBe('only_paid');
    expect(() => validateAudience('nope')).toThrow(ArgumentError);
  });
  it('builds a data uri', () => {
    expect(imageDataUri('QUJD', 'png')).toBe('data:image/png;base64,QUJD');
    expect(imageDataUri('QUJD')).toBe('data:image/jpeg;base64,QUJD');
  });
  it('splits text into paragraphs on blank lines', () => {
    expect(textToParagraphs('one\n\ntwo')).toEqual(['one', 'two']);
    expect(textToParagraphs('soft\nbreak')).toEqual(['soft\nbreak']);
    expect(textToParagraphs('   ')).toEqual([]);
  });
  it('builds paragraph nodes (empty content for empty text)', () => {
    expect(paragraphNode('hi')).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] });
    expect(paragraphNode('')).toEqual({ type: 'paragraph', content: [] });
  });
  it('builds the captionedImage > image2 node', () => {
    const block = imageBlock('https://cdn/x.png', { width: 1000, height: 500 });
    expect(block.type).toBe('captionedImage');
    expect(block.content[0].type).toBe('image2');
    expect(block.content[0].attrs).toMatchObject({ src: 'https://cdn/x.png', width: 1000, height: 500, resizeWidth: 500, imageSize: 'normal' });
  });
  it('wraps blocks into a doc', () => {
    expect(buildDraftBody([paragraphNode('a')])).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] });
  });
});

describe('substack buildDraftPayload', () => {
  it('JSON-stringifies draft_body and sets byline + audience', () => {
    const doc = buildDraftBody([paragraphNode('hello')]);
    const payload = buildDraftPayload({ title: 'T', subtitle: 'S', bodyDoc: doc, userId: 7, audience: 'only_paid', sectionId: 9 });
    expect(payload.draft_title).toBe('T');
    expect(payload.draft_subtitle).toBe('S');
    expect(typeof payload.draft_body).toBe('string');
    expect(JSON.parse(payload.draft_body)).toEqual(doc);
    expect(payload.draft_bylines).toEqual([{ id: 7, is_guest: false }]);
    expect(payload.audience).toBe('only_paid');
    expect(payload.draft_section_id).toBe(9);
    expect(payload.section_chosen).toBe(true);
  });
  it('marks section_chosen false when no section', () => {
    const payload = buildDraftPayload({ title: 'T', bodyDoc: buildDraftBody([]), userId: 1 });
    expect(payload.draft_section_id).toBeNull();
    expect(payload.section_chosen).toBe(false);
  });
});

describe('substack sections', () => {
  const subs = { publications: [{ sections: [{ id: 1, name: 'Tech' }, { id: 2, name: 'Life' }] }, { sections: [{ id: 3, name: 'News' }] }] };
  it('flattens sections from subscriptions', () => {
    expect(collectSections(subs)).toEqual([{ id: 1, name: 'Tech' }, { id: 2, name: 'Life' }, { id: 3, name: 'News' }]);
  });
  it('resolves section id case-insensitively', () => {
    expect(resolveSectionId(collectSections(subs), 'tech')).toBe(1);
  });
  it('throws ArgumentError for an unknown section', () => {
    expect(() => resolveSectionId(collectSections(subs), 'Sports')).toThrow(ArgumentError);
  });
});

describe('substack classifyImages', () => {
  it('classifies urls and paths preserving order', () => {
    expect(classifyImages('https://x/y.png, /local/a.jpg ,http://z/w.gif')).toEqual([
      { kind: 'url', value: 'https://x/y.png' },
      { kind: 'path', value: '/local/a.jpg' },
      { kind: 'url', value: 'http://z/w.gif' },
    ]);
  });
  it('returns [] for empty', () => {
    expect(classifyImages('')).toEqual([]);
    expect(classifyImages(undefined)).toEqual([]);
  });
});
