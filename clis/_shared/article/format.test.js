import { describe, expect, it } from 'vitest';
import { markdownToHtml, looksLikeHtml, normalizeContent } from './format.js';

describe('markdownToHtml', () => {
    it('renders common Markdown to HTML', () => {
        const html = markdownToHtml('# 标题\n\n这是**粗体**和 `code`。');
        expect(html).toContain('<h1>标题</h1>');
        expect(html).toContain('<strong>粗体</strong>');
        expect(html).toContain('<code>code</code>');
    });

    it('renders images and links', () => {
        const html = markdownToHtml('![封面](https://x.com/a.png) [站](https://x.com)');
        expect(html).toContain('<img src="https://x.com/a.png" alt="封面">');
        expect(html).toContain('<a href="https://x.com">站</a>');
    });

    it('renders tables and fenced code blocks', () => {
        const html = markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |');
        expect(html).toContain('<table>');
        const code = markdownToHtml('```js\nconst x = 1\n```');
        expect(code).toContain('<pre><code class="language-js">');
    });

    it('returns empty string for blank input', () => {
        expect(markdownToHtml('')).toBe('');
        expect(markdownToHtml('   ')).toBe('');
    });
});

describe('looksLikeHtml', () => {
    it('detects HTML', () => {
        expect(looksLikeHtml('<p>正文</p>')).toBe(true);
        expect(looksLikeHtml('<img src="a.png">')).toBe(true);
        expect(looksLikeHtml('<div><h2>标题</h2></div>')).toBe(true);
    });
    it('treats Markdown / plain text as not HTML', () => {
        expect(looksLikeHtml('# 标题\n\n**粗体**')).toBe(false);
        expect(looksLikeHtml('![图](u) 普通段落')).toBe(false);
        expect(looksLikeHtml('纯文本')).toBe(false);
    });
});

describe('normalizeContent', () => {
    it('converts Markdown input to both forms', () => {
        const out = normalizeContent('# Hi');
        expect(out.format).toBe('markdown');
        expect(out.markdown).toBe('# Hi');
        expect(out.html).toContain('<h1>Hi</h1>');
    });

    it('keeps HTML input as html (auto-detected)', () => {
        const out = normalizeContent('<p>已是 HTML</p>');
        expect(out.format).toBe('html');
        expect(out.html).toBe('<p>已是 HTML</p>');
    });

    it('honors explicit format override', () => {
        // 显式声明按 HTML 处理，即便它看着像 markdown
        const out = normalizeContent('# 看着像标题', { format: 'html' });
        expect(out.format).toBe('html');
        expect(out.html).toBe('# 看着像标题');
        // 显式声明按 markdown 处理，即便它含 HTML 标签
        const out2 = normalizeContent('<p>x</p>', { format: 'markdown' });
        expect(out2.format).toBe('markdown');
        expect(out2.html).toContain('<p>x</p>');
    });
});
