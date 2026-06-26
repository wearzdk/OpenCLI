/**
 * 文章格式转换 / 归一（共享基础设施）
 *
 * 思路参照 Wechatsync：一篇文章同时带 `markdown`（主）与 `html`，每个平台按自己的
 * 支持度挑用——原生吃 Markdown 的平台（掘金 / CSDN 等）直接发 markdown，只吃 HTML 的
 * 平台（知乎 / 微信等）发 html。AI 交进来的内容多半是 Markdown，所以这里负责把输入
 * 归一成 `{ markdown, html }` 两份，转换用成熟库 markdown-it（不手写造轮子）。
 *
 * 不同平台对 Markdown 的支持本就参差，所以「转还是不转」交给平台 profile 的
 * outputFormat 决定，这里只保证两份内容都备好。
 */
import MarkdownIt from 'markdown-it';

// html:true 允许 Markdown 里内嵌原始 HTML；linkify 自动识别裸链接；表格/删除线默认开。
const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
});

/**
 * Markdown → HTML。
 * @param {string} input Markdown 文本
 * @returns {string} HTML
 */
export function markdownToHtml(input) {
    if (typeof input !== 'string' || !input.trim()) return '';
    return md.render(input).trim();
}

// 粗略判断一段文本「看起来是 HTML 还是 Markdown」。
// 依据：出现块级/常见 HTML 标签的开合标签。Markdown 极少出现成对闭合标签，足够区分日常输入。
const HTML_SIGNAL_RE =
    /<\/(?:p|div|h[1-6]|ul|ol|li|table|tr|td|figure|section|article|span|strong|em|pre|code|blockquote)\s*>|<(?:p|div|h[1-6]|ul|ol|li|table|figure|section|article|img|br|hr)\b[^>]*>/i;

/**
 * 输入大概率是 HTML 吗？纯启发式，仅用于「未显式指定格式」时兜底。
 * @param {string} s
 * @returns {boolean}
 */
export function looksLikeHtml(s) {
    if (typeof s !== 'string') return false;
    return HTML_SIGNAL_RE.test(s);
}

/**
 * 把输入归一成 { format, markdown, html } 两份内容。
 *
 * @param {string} input 文章正文（Markdown 或 HTML）
 * @param {{ format?: 'markdown' | 'html' | 'auto' }} [opts]
 *   format: 显式指定输入格式；'auto'（默认）时用 looksLikeHtml 兜底判别。
 * @returns {{ format: 'markdown' | 'html', markdown: string, html: string }}
 */
export function normalizeContent(input, opts = {}) {
    const raw = typeof input === 'string' ? input : '';
    const want = opts.format || 'auto';
    const isHtml = want === 'html' || (want === 'auto' && looksLikeHtml(raw));

    if (isHtml) {
        // HTML 来源：html 直接用；markdown 字段退化为原文（MD-native 平台通常也能吃内嵌 HTML）。
        return { format: 'html', markdown: raw, html: raw };
    }
    // Markdown 来源：两份都备好。
    return { format: 'markdown', markdown: raw, html: markdownToHtml(raw) };
}

export const __test__ = {
    markdownToHtml,
    looksLikeHtml,
    normalizeContent,
};
