/**
 * 文章发布页面运行时（共享基础设施）
 *
 * 这是「在平台页面上下文里跑」的那一层，移植自 Wechatsync 的 content-processor + CodeAdapter：
 *   - `PP.preprocess(html, config)`  —— 声明式 HTML 预处理（几十个开关），完整移植自
 *     Wechatsync `packages/extension/src/lib/content-processor.ts` 的 preprocessForPlatform。
 *     纯 DOM 操作，本就是在真实 DOM 上跑的；放进 opencli 的 `page.evaluate` 零阻抗。
 *   - `PP.transferImages(content, spec, skip)` —— 统一图片转存（HTML <img> + Markdown ![]()），
 *     去重 / skip 域名 / 失败兜底，移植自 CodeAdapter.processImages + 本仓 images.js。
 *   - 小工具：`PP.cookie(name)` / `PP.xsrf()`。
 *
 * 为什么是「一段字符串」而不是普通模块？
 *   发布必须全程跑在用户已登录的平台标签里（带 cookie、Origin/Referer 天然正确，最强反风控）。
 *   把预处理 + 转存 + 平台发布拼进**同一个 page.evaluate**，能从根上避免 opencli 多次
 *   evaluate 之间标签漂移到 data: 空白页的问题（知乎曾踩过）。所以这层以可注入的源码字符串
 *   形式提供，由 publish.js 拼进单次 evaluate。
 *
 * 可测性：源码字符串在 jsdom 环境里 `eval` 出 `PP` 即可单测（见 page-runtime.test.js，
 * 文件头 `// @vitest-environment jsdom`）。预处理是纯 DOM 逻辑，跟页面内行为一致。
 */

// ── 页面运行时源码（无外部依赖，依赖运行环境的 document / window / fetch）──────────────
// 约定：eval 本字符串后，作用域内出现全局 `PP`。
export const PAGE_RUNTIME = String.raw`
var PP = (function () {
  // ============ 工具 ============
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function cookie(name) {
    try { return (document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)')) || [])[1] || ''; }
    catch (e) { return ''; }
  }
  function pickPath(obj, path) {
    if (obj == null) return undefined;
    var parts = String(path || '').split('.').filter(Boolean);
    var cur = obj;
    for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }

  // ============ 预处理：基础元素清理 ============
  function removeComments(container) {
    var it = document.createNodeIterator(container, NodeFilter.SHOW_COMMENT, null);
    var arr = [], node;
    while ((node = it.nextNode())) arr.push(node);
    arr.forEach(function (c) { c.remove(); });
  }
  function removeElements(container, selectors) {
    container.querySelectorAll(selectors.join(', ')).forEach(function (el) { el.remove(); });
  }
  function removeElementsWithParent(container, selectors) {
    container.querySelectorAll(selectors.join(', ')).forEach(function (el) {
      var parent = el.parentElement;
      if (parent && parent !== container) parent.remove(); else el.remove();
    });
  }
  function processSvgImages(container) {
    container.querySelectorAll('img[src^="data:image/svg"]').forEach(function (img) {
      var dataSrc = img.getAttribute('data-src');
      if (dataSrc) img.setAttribute('src', dataSrc); else img.remove();
    });
  }
  function processLinks(container, keepDomains) {
    container.querySelectorAll('a').forEach(function (link) {
      var href = link.getAttribute('href');
      if (href && keepDomains && keepDomains.length) {
        if (keepDomains.some(function (d) { return href.indexOf(d) !== -1; })) return;
      }
      var span = document.createElement('span');
      span.innerHTML = link.innerHTML;
      if (link.parentNode) link.parentNode.replaceChild(span, link);
    });
  }
  function processLazyImages(container) {
    var lazyAttrs = ['data-src', 'data-original', 'data-actualsrc', '_src'];
    container.querySelectorAll('img').forEach(function (img) {
      for (var i = 0; i < lazyAttrs.length; i++) {
        var lazy = img.getAttribute(lazyAttrs[i]);
        if (lazy && lazy.indexOf('data:image/svg') !== 0) {
          if (!img.getAttribute('src') || (img.getAttribute('src') || '').indexOf('data:image/svg') === 0) {
            img.setAttribute('src', lazy);
          }
          break;
        }
      }
      lazyAttrs.forEach(function (a) { img.removeAttribute(a); });
    });
  }
  function removeEmptyImages(container) {
    container.querySelectorAll('img').forEach(function (img) {
      var src = img.getAttribute('src');
      if (!src) img.remove();
    });
  }
  function removeEmptyElements(container) {
    for (var i = 0; i < 3; i++) {
      var removed = 0;
      container.querySelectorAll('p, div, section, span, figure').forEach(function (el) {
        var hasText = el.textContent && el.textContent.trim();
        var hasMedia = el.querySelector('img, video, audio, iframe, canvas, svg');
        if (!hasText && !hasMedia) { el.remove(); removed++; }
      });
      if (removed === 0) break;
    }
  }
  function removeDataAttributes(container) {
    container.querySelectorAll('*').forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        if (attr.name.indexOf('data-') === 0 && attr.name !== 'data-src') el.removeAttribute(attr.name);
      });
    });
  }
  function removeImageAttributes(container, config) {
    container.querySelectorAll('img').forEach(function (img) {
      if (config.removeSrcset) img.removeAttribute('srcset');
      if (config.removeSizes) img.removeAttribute('sizes');
      img.removeAttribute('loading');
      img.removeAttribute('decoding');
    });
  }
  function convertSections(container, targetTag) {
    container.querySelectorAll('section').forEach(function (section) {
      var newEl = document.createElement(targetTag);
      newEl.innerHTML = section.innerHTML;
      Array.prototype.slice.call(section.attributes).forEach(function (attr) {
        newEl.setAttribute(attr.name, attr.value);
      });
      if (section.parentNode) section.parentNode.replaceChild(newEl, section);
    });
  }
  function removeTrailingBr(container) {
    container.querySelectorAll('p, div, section').forEach(function (el) {
      while (el.lastElementChild && el.lastElementChild.tagName === 'BR') el.lastElementChild.remove();
    });
  }
  function flattenNestedBold(container) {
    var selectors = ['b b', 'b strong', 'strong b', 'strong strong'];
    for (var i = 0; i < 5; i++) {
      var removed = 0;
      selectors.forEach(function (sel) {
        container.querySelectorAll(sel).forEach(function (inner) {
          var parent = inner.parentNode;
          if (!parent) return;
          while (inner.firstChild) parent.insertBefore(inner.firstChild, inner);
          parent.removeChild(inner);
          removed++;
        });
      });
      if (removed === 0) break;
    }
  }
  function unwrapSingleChildSpans(container) {
    for (var i = 0; i < 10; i++) {
      var unwrapped = 0;
      Array.prototype.slice.call(container.querySelectorAll('span')).forEach(function (span) {
        if (!span.parentNode) return;
        if (span.childNodes.length === 0) return;
        var hasDirectText = Array.prototype.slice.call(span.childNodes).some(function (node) {
          return node.nodeType === 3 && node.textContent && node.textContent.trim();
        });
        if (hasDirectText) return;
        var parent = span.parentNode;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
        unwrapped++;
      });
      if (unwrapped === 0) break;
    }
  }
  function unwrapNestedFigures(container) {
    for (var i = 0; i < 5; i++) {
      var nested = container.querySelectorAll('figure > figure');
      if (nested.length === 0) break;
      nested.forEach(function (innerFigure) {
        var outer = innerFigure.parentElement;
        if (outer && outer.tagName === 'FIGURE' && outer.parentNode) {
          outer.parentNode.replaceChild(innerFigure, outer);
        }
      });
    }
  }
  function unwrapSingleChildContainers(container) {
    for (var i = 0; i < 5; i++) {
      var unwrapped = 0;
      container.querySelectorAll('div').forEach(function (div) {
        var children = Array.prototype.slice.call(div.childNodes).filter(function (node) {
          return node.nodeType === 1 || (node.nodeType === 3 && node.textContent && node.textContent.trim());
        });
        if (children.length === 1 && children[0].nodeType === 1) {
          var child = children[0];
          if (['DIV', 'ARTICLE', 'P', 'SECTION'].indexOf(child.tagName) !== -1 && div.parentNode) {
            div.parentNode.replaceChild(child, div);
            unwrapped++;
          }
        }
      });
      if (unwrapped === 0) break;
    }
  }
  function compactHtml(container) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    var toRemove = [], node;
    while ((node = walker.nextNode())) {
      if (node.textContent && /^\s+$/.test(node.textContent)) {
        var prev = node.previousSibling, next = node.nextSibling, parent = node.parentNode;
        if (parent && !(parent.closest && parent.closest('pre, code'))) {
          if ((!prev || prev.nodeType === 1) && (!next || next.nodeType === 1)) toRemove.push(node);
        }
      }
    }
    toRemove.forEach(function (n) { n.remove(); });
  }
  function onlyBrOrWhitespace(el) {
    return Array.prototype.slice.call(el.childNodes).every(function (node) {
      if (node.nodeType === 3) return !(node.textContent && node.textContent.trim());
      if (node.nodeType === 1) return node.tagName === 'BR';
      return true;
    });
  }
  function removeEmptyLines(container) {
    container.querySelectorAll('p, section').forEach(function (el) {
      if (onlyBrOrWhitespace(el)) el.remove();
    });
  }
  function removeEmptyDivs(container) {
    container.querySelectorAll('div').forEach(function (div) {
      if (div.querySelector('img, video, audio, canvas, svg, iframe')) return;
      if (onlyBrOrWhitespace(div)) div.remove();
    });
  }
  function removeNestedEmptyContainers(container) {
    for (var i = 0; i < 5; i++) {
      var removed = 0;
      container.querySelectorAll('div, section, article, span').forEach(function (el) {
        if (el.querySelector('img, video, audio, canvas, svg, iframe')) return;
        var text = (el.textContent && el.textContent.trim()) || '';
        var hasChildren = el.children.length > 0;
        if (!text && !hasChildren) { el.remove(); removed++; return; }
        if (!text && hasChildren) {
          var allBr = Array.prototype.slice.call(el.children).every(function (c) { return c.tagName === 'BR'; });
          if (allBr) { el.remove(); removed++; }
        }
      });
      if (removed === 0) break;
    }
  }
  function convertTablesToText(container) {
    container.querySelectorAll('table').forEach(function (table) {
      var headers = [];
      var theadRow = table.querySelector('thead tr');
      if (theadRow) theadRow.querySelectorAll('th, td').forEach(function (cell) {
        headers.push((cell.textContent && cell.textContent.trim()) || '');
      });
      var rows = [];
      var bodyRows = table.querySelectorAll('tbody tr, tr');
      Array.prototype.slice.call(bodyRows).forEach(function (row, ri) {
        if (row.parentElement && row.parentElement.tagName === 'THEAD') return;
        var cells = row.querySelectorAll('td, th');
        if (headers.length === 0 && row === bodyRows[0]) {
          var allTh = Array.prototype.slice.call(cells).every(function (c) { return c.tagName === 'TH'; });
          if (allTh) { cells.forEach(function (cell) { headers.push((cell.textContent && cell.textContent.trim()) || ''); }); return; }
        }
        var rowData = [];
        cells.forEach(function (cell) { rowData.push((cell.textContent && cell.textContent.trim()) || ''); });
        if (rowData.length > 0) rows.push(rowData);
      });
      var frag = document.createDocumentFragment();
      if (headers.length > 0) {
        rows.forEach(function (row) {
          var parts = row.map(function (val, i) { var h = headers[i] || ''; return h ? (h + ': ' + val) : val; });
          var p = document.createElement('p'); p.textContent = parts.join(' | '); frag.appendChild(p);
        });
      } else {
        rows.forEach(function (row) {
          var p = document.createElement('p'); p.textContent = row.join(' | '); frag.appendChild(p);
        });
      }
      table.replaceWith(frag);
    });
  }

  // ============ 预处理：代码块 ============
  var LINE_CONTAINER_TAGS = { CODE: 1, DIV: 1, P: 1, LI: 1 };
  function isValidLineStructure(children) {
    if (children.length < 2) return false;
    var firstTag = children[0].tagName;
    if (firstTag === 'BR') return false;
    if (LINE_CONTAINER_TAGS[firstTag]) {
      var allSame = children.every(function (c) { return c.tagName === firstTag; });
      if (!allSame) return false;
      var parent = children[0].parentElement;
      if (parent) {
        var nodes = Array.prototype.slice.call(parent.childNodes);
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].nodeType === 3 && nodes[i].textContent && nodes[i].textContent.trim()) return false;
        }
      }
      return true;
    }
    return children.every(function (c) {
      var style = c.getAttribute('style') || '';
      return style.indexOf('display:block') !== -1 || style.indexOf('display: block') !== -1;
    });
  }
  function findLinesContainer(el, depth) {
    if (depth > 4) return null;
    var children = Array.prototype.slice.call(el.children);
    if (isValidLineStructure(children)) return el;
    if (children.length === 1) return findLinesContainer(children[0], depth + 1);
    return null;
  }
  function isLineNumberContainer(el, codeLineCount) {
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      var items = el.querySelectorAll('li');
      if (items.length >= 2 && items.length === codeLineCount) {
        var allEmpty = Array.prototype.slice.call(items).every(function (li) { return !(li.textContent && li.textContent.trim()); });
        if (allEmpty) return true;
      }
      if (items.length >= 2) {
        var seq = true;
        Array.prototype.slice.call(items).forEach(function (li, i) {
          if (parseInt((li.textContent && li.textContent.trim()) || '', 10) !== i + 1) seq = false;
        });
        if (seq) return true;
      }
    }
    var text = (el.textContent && el.textContent.trim()) || '';
    var lines = text.split(/[\n\r]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (lines.length >= 2) {
      if (lines.every(function (line, i) { return parseInt(line, 10) === i + 1; })) return true;
    }
    return false;
  }
  function removeLineNumberSiblings(pre) {
    var parent = pre.parentElement;
    if (!parent) return;
    var codeElements = pre.querySelectorAll('code');
    var codeLineCount = codeElements.length > 1 ? codeElements.length : ((pre.textContent || '').split('\n').length || 0);
    Array.prototype.slice.call(parent.children).forEach(function (sib) {
      if (sib !== pre && isLineNumberContainer(sib, codeLineCount)) sib.remove();
    });
  }
  function detectCodeLang(pre) {
    var els = [pre, pre.querySelector('code')].filter(Boolean);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var dataLang = el.getAttribute('data-lang');
      if (dataLang) return dataLang.trim().toLowerCase();
      var m = (el.className || '').match(/(?:language|lang|highlight)-(\w+)/);
      if (m) return m[1].toLowerCase();
      var wx = (el.className || '').match(/code-snippet__(\w+)/);
      if (wx) return wx[1].toLowerCase();
    }
    return null;
  }
  function processCodeBlocks(container) {
    removeElements(container, [
      'ul.code-snippet__line-index', '.code-snippet__line-index',
      '.line-numbers-rows', '.hljs-ln-numbers', '.gutter',
    ]);
    container.querySelectorAll('pre').forEach(function (pre) {
      try {
        if (pre.hasAttribute('data-code-simplified')) return;
        removeLineNumberSiblings(pre);
        var linesContainer = findCodeLinesContainerSafe(pre);
        var newHtml;
        if (linesContainer) {
          var lines = [];
          Array.prototype.slice.call(linesContainer.children).forEach(function (child) {
            lines.push(escapeHtml(child.textContent || ''));
          });
          newHtml = lines.join('\n');
        } else {
          var text = pre.innerText || pre.textContent || '';
          newHtml = '<code>' + escapeHtml(text) + '</code>';
        }
        newHtml = newHtml.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '');
        if (!newHtml.trim()) { pre.remove(); return; }
        var lang = detectCodeLang(pre);
        pre.innerHTML = newHtml;
        pre.removeAttribute('class'); pre.removeAttribute('style'); pre.removeAttribute('data-lang');
        if (lang) { pre.setAttribute('data-lang', lang); pre.className = 'language-' + lang; }
      } catch (e) {}
    });
  }
  function findCodeLinesContainerSafe(pre) { return findLinesContainer(pre, 0); }

  // ============ 预处理：源平台链接清理（默认保守，无内置域名表）============
  function cleanSourcePlatformLinks(container, removeDomains, redirectRules) {
    var rd = removeDomains || [], rr = redirectRules || [];
    if (!rd.length && !rr.length) return;
    Array.prototype.slice.call(container.querySelectorAll('a')).forEach(function (link) {
      var href = link.getAttribute('href') || '';
      if (rd.some(function (d) { return href.indexOf(d) !== -1; })) {
        var parent = link.parentNode;
        if (!parent) return;
        while (link.firstChild) parent.insertBefore(link.firstChild, link);
        parent.removeChild(link);
        return;
      }
      var rule = rr.find(function (r) { return href.indexOf(r.domain) !== -1; });
      if (rule) {
        try { var u = new URL(href); var real = u.searchParams.get(rule.param); if (real) link.setAttribute('href', real); } catch (e) {}
      }
    });
  }

  // ============ 预处理入口：按 config 跑流水线，返回处理后 HTML ============
  // 完整移植 Wechatsync preprocessForPlatform 的 DOM 流水线（不含 html→markdown 那步，
  // markdown 由 Node 侧 markdown-it 负责）。
  function preprocess(rawHtml, config) {
    config = config || {};
    var container = document.createElement('div');
    container.innerHTML = rawHtml || '';

    if (config.processCodeBlocks) processCodeBlocks(container);
    if (config.removeComments) removeComments(container);
    if (config.removeIframes) removeElements(container, ['iframe']);
    if (config.removeSpecialTags) {
      if (config.removeSpecialTagsWithParent) {
        removeElementsWithParent(container, ['mpprofile', 'qqmusic']);
        removeElements(container, ['mpvoice', 'mpcps', 'mp-miniprogram', 'mp-common-product']);
      } else {
        removeElements(container, ['mpprofile', 'qqmusic', 'mpvoice', 'mpcps', 'mp-miniprogram', 'mp-common-product']);
      }
    }
    if (config.removeSvgImages) processSvgImages(container);
    removeElements(container, config.keepStyles ? ['script', 'noscript'] : ['script', 'style', 'noscript']);
    cleanSourcePlatformLinks(container, config.sourceLinkRemoveDomains, config.sourceLinkRedirectRules);
    if (config.removeLinks) processLinks(container, config.keepLinkDomains);
    if (config.processLazyImages) processLazyImages(container);
    if (config.removeEmptyElements) removeEmptyElements(container);
    if (config.removeEmptyImages) removeEmptyImages(container);
    if (config.removeDataAttributes) removeDataAttributes(container);
    if (config.removeSrcset || config.removeSizes) removeImageAttributes(container, config);
    if (config.convertSectionToDiv) convertSections(container, 'div');
    else if (config.convertSectionToP) convertSections(container, 'p');
    if (config.removeTrailingBr) removeTrailingBr(container);
    if (config.unwrapNestedFigures) unwrapNestedFigures(container);
    if (config.flattenNestedBold) flattenNestedBold(container);
    if (config.unwrapSingleChildSpans) unwrapSingleChildSpans(container);
    if (config.unwrapSingleChildContainers) unwrapSingleChildContainers(container);
    if (config.compactHtml) compactHtml(container);
    if (config.convertTablesToText) convertTablesToText(container);
    if (config.removeEmptyLines) removeEmptyLines(container);
    if (config.removeEmptyDivs) removeEmptyDivs(container);
    if (config.removeNestedEmptyContainers) removeNestedEmptyContainers(container);

    return container.innerHTML;
  }

  // ============ 图片转存（统一）============
  // content 里所有图片（HTML <img> + Markdown ![]()）逐张转存到本平台图床，原地改写 src。
  // spec 见 images.js 注释：bodyType form(传URL,服务端自拉) / json / binary-multipart(下字节再传)。
  function extractRefs(content) {
    var refs = [], m;
    var htmlRe = /<img\b[^>]*?\ssrc=("|')(.*?)\1[^>]*>/gi;
    var mdRe = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
    while ((m = htmlRe.exec(content)) !== null) refs.push({ full: m[0], src: m[2] });
    while ((m = mdRe.exec(content)) !== null) refs.push({ full: m[0], src: m[1] });
    return refs;
  }
  function subst(v, src) {
    if (typeof v === 'string') return v.split('{src}').join(src);
    if (Array.isArray(v)) return v.map(function (x) { return subst(x, src); });
    if (v && typeof v === 'object') { var o = {}; for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = subst(v[k], src); return o; }
    return v;
  }
  async function transferImages(content, spec, skip) {
    spec = spec || null; skip = skip || [];
    var report = { content: content, uploaded: [], failed: [] };
    if (!spec || !spec.url) return report;
    var refs = extractRefs(content);
    if (refs.length === 0) return report;

    var xsrf = cookie('_xsrf');
    var cache = {};
    var out = content;
    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i], src = ref.src;
      if (!src) continue;
      var isData = src.indexOf('data:') === 0;
      if (!isData && skip.some(function (p) { return src.indexOf(p) !== -1; })) continue;

      if (!(src in cache)) {
        try {
          var bt = spec.bodyType || 'form';
          var headers = Object.assign({}, spec.headers || {});
          if (spec.xsrf && xsrf) headers['x-xsrftoken'] = xsrf;
          var body;
          if (bt === 'form') {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            body = new URLSearchParams(subst(spec.body || {}, src));
          } else if (bt === 'json') {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(subst(spec.body || {}, src));
          } else if (bt === 'binary-multipart') {
            var blob = await (await fetch(src, { credentials: 'omit' })).blob();
            var fd = new FormData();
            fd.append(spec.fileField || 'file', blob, spec.fileName || 'image');
            var extra = subst(spec.body || {}, src);
            for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) fd.append(k, String(extra[k]));
            body = fd;
          } else {
            throw new Error('unknown bodyType: ' + bt);
          }
          var url = subst(spec.url, src);
          var resp = await fetch(url, { method: spec.method || 'POST', credentials: 'include', headers: headers, body: body });
          var txt = await resp.text();
          var json = null; try { json = JSON.parse(txt); } catch (e) {}
          if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + txt.slice(0, 150));
          var newUrl = spec.responsePath ? pickPath(json, spec.responsePath) : (json && (json.url || json.src));
          if (!newUrl) throw new Error('no url in response: ' + txt.slice(0, 150));
          cache[src] = newUrl;
          report.uploaded.push({ src: src.slice(0, 120), url: newUrl });
        } catch (e) {
          cache[src] = null;
          report.failed.push({ src: src.slice(0, 120), error: String((e && e.message) || e) });
        }
        await new Promise(function (r) { setTimeout(r, spec.throttleMs != null ? spec.throttleMs : 250); });
      }
      var nu = cache[src];
      if (nu) out = out.split(ref.full).join(ref.full.replace(src, nu));
    }
    report.content = out;
    return report;
  }

  // 用自定义上传函数转存（移植自 CodeAdapter.processImages）。
  // uploadFn: async (src) => ({ url, attrs? }) | url。用于装不进声明式 spec 的平台
  // （如掘金 ImageX 多步 + AWS4 签名）：平台自己实现「拿到 src → 返回新 URL」即可。
  // 同样统一处理 HTML <img> + Markdown ![]()，去重 / skip / 失败兜底。
  async function processImagesWith(content, uploadFn, opts) {
    opts = opts || {};
    var skip = opts.skip || [];
    var throttleMs = opts.throttleMs != null ? opts.throttleMs : 300;
    var report = { content: content, uploaded: [], failed: [] };
    if (typeof uploadFn !== 'function') return report;
    var refs = extractRefs(content);
    if (refs.length === 0) return report;

    var cache = {};
    var out = content;
    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i], src = ref.src;
      if (!src) continue;
      var isData = src.indexOf('data:') === 0;
      if (!isData && skip.some(function (p) { return src.indexOf(p) !== -1; })) continue;

      if (!(src in cache)) {
        try {
          var res = await uploadFn(src);
          var url = (res && typeof res === 'object') ? res.url : res;
          if (!url) throw new Error('uploadFn returned no url');
          cache[src] = { url: url, attrs: (res && res.attrs) || null };
          report.uploaded.push({ src: src.slice(0, 120), url: url });
        } catch (e) {
          cache[src] = null;
          report.failed.push({ src: src.slice(0, 120), error: String((e && e.message) || e) });
        }
        await new Promise(function (r) { setTimeout(r, throttleMs); });
      }
      var hit = cache[src];
      if (hit && hit.url) out = out.split(ref.full).join(ref.full.replace(src, hit.url));
    }
    report.content = out;
    return report;
  }

  return {
    preprocess: preprocess,
    transferImages: transferImages,
    processImagesWith: processImagesWith,
    cookie: cookie,
    xsrf: function () { return cookie('_xsrf'); },
    escapeHtml: escapeHtml,
    pickPath: pickPath,
  };
})();
`;

/**
 * 在 jsdom（或任何带 document 的环境）里求值出 PP，供单测使用。
 * 仅测试用途；真实发布时由 publish.js 把 PAGE_RUNTIME 拼进 page.evaluate。
 * @returns {{ preprocess: Function, transferImages: Function, cookie: Function, xsrf: Function }}
 */
export function evalPageRuntime() {
    // eslint-disable-next-line no-new-func
    return new Function(PAGE_RUNTIME + '\nreturn PP;')();
}
