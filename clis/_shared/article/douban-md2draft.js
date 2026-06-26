/**
 * Markdown → Draft.js 转换（豆瓣专用）
 *
 * 直接移植自 Wechatsync v2 packages/core/src/lib/markdown-to-draft.ts（开源实现，
 * 基于 markdown-draft-js + remarkable），只做 TS→JS 去类型化。豆瓣新版「日记/note」
 * 编辑器（/topic/create）正文仍是 Draft.js ContentState，故此转换器照样适用。
 *
 * 图片：转换阶段先产出占位 IMAGE 实体（data.url = 外链原图），真正的转存（上传到豆瓣
 * 图床、回填 photo 数据 + image_ids）在页面内 evaluate 里完成。两种调用方式都支持：
 * 传入 imageDataMap 则直接填完整 photo 数据；不传则留外链占位，供页面内回填。
 */

// markdown-draft-js 无类型定义
import { markdownToDraft as mdToDraft } from 'markdown-draft-js';
import { Remarkable } from 'remarkable';

const ImageRegexp = /^!\[([^\]]*)]\s*\(([^)"]+)( "([^)"]+)")?\)/;

/**
 * 豆瓣图片 Block 解析器 —— 把单独成行的 ![](url) 提升为块级 image token。
 * @param {Remarkable} remarkable
 */
const imageBlockPlugin = (remarkable) => {
    remarkable.block.ruler.before('paragraph', 'image', (state, startLine, _endLine, silent) => {
        const pos = state.bMarks[startLine] + state.tShift[startLine];
        const max = state.eMarks[startLine];

        if (pos >= max) return false;
        if (!state.src) return false;
        if (state.src[pos] !== '!') return false;

        const match = ImageRegexp.exec(state.src.slice(pos));
        if (!match) return false;

        if (!silent) {
            state.tokens.push({ type: 'image_open', src: match[2], alt: match[1], lines: [startLine, state.line], level: state.level });
            state.tokens.push({ type: 'image_close', level: state.level });
        }

        state.line = startLine + 1;
        return true;
    });
};

/**
 * 将 Markdown 转换为 Draft.js ContentState 对象。
 * @param {string} markdown
 * @param {Map<string, object>} [imageDataMap]  图片 URL → 完整 photo 数据（可选）
 * @returns {{ blocks: Array<object>, entityMap: Record<string, object> }}
 */
export function markdownToDraftState(markdown, imageDataMap = new Map()) {
    // 保证图片单独成行（![]( 前插换行），否则会被并进段落
    const processedMarkdown = markdown.split('\n').map((line) => {
        const imageBlocks = line.split('![]');
        return imageBlocks.length > 1 ? imageBlocks.join('\n![]') : line;
    }).join('\n');

    let keyCounter = 0;
    const generateUniqueKey = () => keyCounter++;

    const buildImageData = (item) => {
        const sourcePair = item.src ? item.src.split('?#') : ['', ''];
        const rawSrc = sourcePair[0];
        const sourceId = sourcePair[1] || '';
        const imgData = imageDataMap.get(item.src) || imageDataMap.get(rawSrc);
        if (imgData) {
            return {
                id: imgData.id, src: imgData.url, thumb: imgData.thumb, url: imgData.url,
                width: imgData.width, height: imgData.height, file_name: imgData.file_name, file_size: imgData.file_size,
            };
        }
        // 占位：data.url = 外链原图，供页面内转存后回填
        return { id: sourceId, src: rawSrc, thumb: rawSrc, url: rawSrc };
    };

    const draftState = mdToDraft(processedMarkdown, {
        remarkablePlugins: [imageBlockPlugin],
        blockTypes: {
            image_open: function (item) {
                const key = generateUniqueKey();
                const blockEntities = {};
                blockEntities[key] = { type: 'IMAGE', mutability: 'IMMUTABLE', data: buildImageData(item) };
                return {
                    type: 'atomic',
                    blockEntities,
                    inlineStyleRanges: [],
                    entityRanges: [{ offset: 0, length: 1, key }],
                    text: ' ',
                };
            },
        },
        blockEntities: {
            image: function (item) {
                return { type: 'IMAGE', mutability: 'IMMUTABLE', data: buildImageData(item) };
            },
        },
    });

    // 把 block.blockEntities 合并进顶层 entityMap（参考 mtd.js）
    if (draftState.blocks) {
        for (const block of draftState.blocks) {
            if (block.blockEntities) {
                Object.assign(draftState.entityMap, block.blockEntities);
                delete block.blockEntities;
            }
        }
    }

    return draftState;
}
