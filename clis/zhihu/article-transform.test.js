import { describe, expect, it } from 'vitest';
import { transformZhihuHtml, transformTables } from './article-transform.js';

describe('transformZhihuHtml', () => {
    it('wraps images in <figure>', () => {
        const out = transformZhihuHtml('<p><img src="https://pic.zhimg.com/a.png" alt="x"></p>');
        expect(out).toContain('<figure><img');
        expect(out).toContain('src="https://pic.zhimg.com/a.png"');
        // 不重复包裹
        expect(out).not.toMatch(/<figure>\s*<figure>/);
    });

    it('converts fenced code blocks to zhihu pre[lang]', () => {
        const out = transformZhihuHtml('<pre><code class="language-js">const x = 1</code></pre>');
        expect(out).toContain('<pre lang="js"><code>');
    });

    it('strips inline style and non-draft data attributes', () => {
        const out = transformZhihuHtml('<p style="color:red" data-foo="1">文字</p>');
        expect(out).not.toContain('style=');
        expect(out).not.toContain('data-foo');
    });
});

describe('transformTables', () => {
    it('rewrites a thead/tbody table into zhihu Draft.js form', () => {
        const html =
            '<table><thead><tr><td>A</td><td>B</td></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
        const out = transformTables(html);
        expect(out).toContain('data-draft-type="table"');
        expect(out).toContain('<tbody>');
        // 表头单元格升级为 th
        expect(out).toContain('<th>A</th>');
        expect(out).toContain('<td>1</td>');
    });

    it('unwraps a table nested in figure', () => {
        const html = '<figure><table><tbody><tr><td>1</td></tr></tbody></table></figure>';
        const out = transformTables(html);
        expect(out).toContain('data-draft-node="block"');
        expect(out.indexOf('<figure>')).toBe(-1);
    });
});
