/**
 * 知乎正文 HTML 微调（移植自 Wechatsync 的 zhihu 适配器 transformContent/transformTables）
 *
 * 知乎专栏编辑器（Draft.js）对 HTML 有自己的口味：图片要用 <figure> 包裹、代码块用
 * <pre lang>、表格要带 data-draft-* 标记并塞进 <tbody>。这里把这些「平台专属口味」收成
 * 一个纯字符串函数，供发布编排器在图片转存之后、调发布 API 之前调用。
 *
 * 纯函数、无依赖，可在 Node 直接测。
 */

/**
 * 把 markdown-it / 通用 HTML 里的 <table> 转成知乎 Draft.js 期望的结构。
 * @param {string} html
 * @returns {string}
 */
export function transformTables(html) {
    // 1. 解包 figure 里的 table（知乎表格不该被 figure 包着）
    let result = html.replace(
        /<figure[^>]*>\s*(<table[\s\S]*?<\/table>)\s*<\/figure>/gi,
        '$1',
    );

    // 2. 转换每个 table 结构
    result = result.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_match, tableContent) => {
        const theadMatch = tableContent.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
        const tbodyMatch = tableContent.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);

        let headerRows = '';
        let bodyRows = '';

        if (theadMatch) {
            // 表头行确保用 <th>
            headerRows = theadMatch[1]
                .replace(/<td([^>]*)>/gi, '<th$1>')
                .replace(/<\/td>/gi, '</th>');
        }

        if (tbodyMatch) {
            bodyRows = tbodyMatch[1];
        } else {
            // 没有 tbody：整段作为 body（排除 thead）
            bodyRows = tableContent
                .replace(/<thead[^>]*>[\s\S]*?<\/thead>/gi, '')
                .replace(/<\/?tbody[^>]*>/gi, '');
        }

        // 没有 thead 时，若首行全是 th 则当表头
        if (!theadMatch) {
            const firstRowMatch = bodyRows.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
            if (firstRowMatch) {
                const firstRowContent = firstRowMatch[1];
                if (/<th[^>]*>/i.test(firstRowContent) && !/<td[^>]*>/i.test(firstRowContent)) {
                    headerRows = firstRowMatch[0];
                    bodyRows = bodyRows.replace(firstRowMatch[0], '');
                }
            }
        }

        return `<table data-draft-node="block" data-draft-type="table" data-size="normal" data-row-style="normal"><tbody>${headerRows}${bodyRows}</tbody></table>`;
    });

    return result;
}

/**
 * 知乎正文整体微调。
 * @param {string} content 已完成图片转存的 HTML
 * @returns {string}
 */
export function transformZhihuHtml(content) {
    let result = content;

    // 1. 表格 → 知乎 Draft.js 格式
    result = transformTables(result);

    // 2. 图片用 <figure> 包裹（避免重复包裹已在 figure 里的）
    result = result.replace(
        /<img([^>]+)src="([^"]+)"([^>]*?)\/?>/gi,
        (match, pre, src, post) => `<figure><img${pre}src="${src}"${post}></figure>`,
    );
    // 解包可能出现的 figure 套 figure
    result = result.replace(/<figure>\s*(<figure>[\s\S]*?<\/figure>)\s*<\/figure>/gi, '$1');

    // 3. 代码块：<pre><code class="language-x"> → <pre lang="x"><code>
    result = result.replace(
        /<pre><code class="language-(\w+)">/gi,
        '<pre lang="$1"><code>',
    );

    // 4. 去掉非 data-draft 的 data-* 属性与内联 style（清掉外站/markdown 残留样式）
    result = result.replace(/\s*data-(?!draft)[a-z-]+="[^"]*"/gi, '');
    result = result.replace(/\s*style="[^"]*"/gi, '');

    return result;
}

export const __test__ = {
    transformTables,
    transformZhihuHtml,
};
