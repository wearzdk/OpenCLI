/**
 * 文章图片转存（共享基础设施）
 *
 * 背景：把一篇文章发到某个平台时，正文里的图片几乎都指向「别处」（原站 CDN、图床、
 * data URI）。平台编辑器不允许外链热链，所以必须把每张图重新「转存」到该平台自己的
 * 图床，再把正文里的 src 换成平台返回的新地址——否则发出去的文章图全裂。这一步过去
 * 要 AI 自己摸索几十步，是最容易被忽略、又最影响成片率的坑。
 *
 * 这里把「转存」抽象成一条声明式流水线：
 *   - 扫描正文里所有图片引用（HTML <img> 与 Markdown ![]()）；
 *   - 跳过「已经在本平台」的图（skip 域名）和上传失败的图；
 *   - 对其余每张图，按平台声明的 `spec` 调一次上传接口，拿到新 URL；
 *   - 把正文里的旧 src 原地换成新 URL（保留 alt/属性不动）。
 *
 * 关键：真正的上传 fetch 必须跑在**平台页面上下文**里（带着用户登录 cookie、Origin/
 * Referer 自动正确），所以核心逻辑被编译成一段在 `page.evaluate` 里执行的脚本。
 * 接一个平台 = 写一份 `spec`，不用各写各的上传管道。
 *
 * 上传策略由 `spec.bodyType` 决定：
 *   - 'form'：表单提交。最省事的「传 URL」式——把远程图片 URL 交给平台，平台服务端
 *     自己去拉取转存（如知乎 /api/uploaded_images）。无需下载字节。
 *   - 'json'：同上，但 JSON body。
 *   - 'binary-multipart'：页面内先 fetch 拿到图片字节，再以 multipart 上传（用于没有
 *     「传 URL」接口、或处理 data URI 的平台）。
 *
 * `spec` 字段：
 *   url           上传接口地址，可含占位符 {src}
 *   method        默认 POST
 *   bodyType      'form' | 'json' | 'binary-multipart'，默认 'form'
 *   body          请求体模板（对象），值里的 '{src}' 会被替换成当前图片地址
 *   headers       附加请求头
 *   xsrf          true 时自动从 _xsrf cookie 注入 x-xsrftoken（知乎等需要）
 *   responsePath  从 JSON 响应里取新 URL 的路径，如 'src' 或 'data.url'
 *   fileField     binary-multipart 时图片字段名，默认 'file'
 *   fileName      binary-multipart 时文件名，默认 'image'
 *   throttleMs    每张图之间的间隔毫秒，默认 250
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HTML_IMG_RE = /<img\b[^>]*?\ssrc=("|')(.*?)\1[^>]*>/gi;
// Markdown 图片：![alt](url "title")。只取 url 部分，title/尺寸后缀忽略。
const MD_IMG_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;

/**
 * 从正文里抽取所有图片引用。返回 [{ full, src }]，full 是原始匹配片段，
 * 替换时用 full.replace(src, newUrl) 原地换 URL，保留其余属性。
 * 纯函数，可在 Node 直接测。
 */
export function extractImageRefs(content) {
    const refs = [];
    if (typeof content !== 'string' || !content) return refs;
    let m;
    HTML_IMG_RE.lastIndex = 0;
    while ((m = HTML_IMG_RE.exec(content)) !== null) {
        refs.push({ full: m[0], src: m[2] });
    }
    MD_IMG_RE.lastIndex = 0;
    while ((m = MD_IMG_RE.exec(content)) !== null) {
        refs.push({ full: m[0], src: m[1] });
    }
    return refs;
}

/**
 * 从对象里按 'a.b.c' 路径取值。纯函数。
 */
export function pickPath(obj, path) {
    if (obj == null) return undefined;
    const parts = String(path || '').split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
    }
    return cur;
}

// 在页面上下文里执行的转存脚本主体（无 ${} / 无反引号，便于以模板字符串包裹注入）。
// 依赖注入的三个常量：content、spec、skip。
const IN_PAGE_BODY = `
  const htmlRe = /<img\\b[^>]*?\\ssrc=("|')(.*?)\\1[^>]*>/gi;
  const mdRe = /!\\[[^\\]]*\\]\\(\\s*<?([^)\\s>]+)>?[^)]*\\)/g;
  const refs = [];
  let rm;
  while ((rm = htmlRe.exec(content)) !== null) refs.push({ full: rm[0], src: rm[2] });
  while ((rm = mdRe.exec(content)) !== null) refs.push({ full: rm[0], src: rm[1] });

  function pickPath(obj, path) {
    if (obj == null) return undefined;
    const parts = String(path || '').split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
    return cur;
  }
  function subst(v, src) {
    if (typeof v === 'string') return v.split('{src}').join(src);
    if (Array.isArray(v)) return v.map(function (x) { return subst(x, src); });
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = subst(v[k], src);
      return o;
    }
    return v;
  }

  const xsrf = (document.cookie.match(/_xsrf=([^;]+)/) || [])[1] || '';
  const cache = {};
  const uploaded = [];
  const failed = [];
  let out = content;

  for (const ref of refs) {
    const src = ref.src;
    if (!src) continue;
    const isData = src.indexOf('data:') === 0;
    if (!isData && skip.some(function (p) { return src.indexOf(p) !== -1; })) continue;

    if (!(src in cache)) {
      try {
        const bt = spec.bodyType || 'form';
        const headers = Object.assign({}, spec.headers || {});
        if (spec.xsrf && xsrf) headers['x-xsrftoken'] = xsrf;
        let body;
        if (bt === 'form') {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
          body = new URLSearchParams(subst(spec.body || {}, src));
        } else if (bt === 'json') {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(subst(spec.body || {}, src));
        } else if (bt === 'binary-multipart') {
          const blob = await (await fetch(src, { credentials: 'omit' })).blob();
          const fd = new FormData();
          fd.append(spec.fileField || 'file', blob, spec.fileName || 'image');
          const extra = subst(spec.body || {}, src);
          for (const k of Object.keys(extra)) fd.append(k, String(extra[k]));
          body = fd;
        } else {
          throw new Error('unknown bodyType: ' + bt);
        }
        const url = subst(spec.url, src);
        const resp = await fetch(url, {
          method: spec.method || 'POST',
          credentials: 'include',
          headers: headers,
          body: body,
        });
        const txt = await resp.text();
        let json = null;
        try { json = JSON.parse(txt); } catch (e) {}
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + txt.slice(0, 150));
        const newUrl = spec.responsePath
          ? pickPath(json, spec.responsePath)
          : (json && (json.url || json.src));
        if (!newUrl) throw new Error('no url in response: ' + txt.slice(0, 150));
        cache[src] = newUrl;
        uploaded.push({ src: src.slice(0, 120), url: newUrl });
      } catch (e) {
        cache[src] = null;
        failed.push({ src: src.slice(0, 120), error: String((e && e.message) || e) });
      }
      await new Promise(function (r) { setTimeout(r, spec.throttleMs != null ? spec.throttleMs : 250); });
    }

    const nu = cache[src];
    if (nu) out = out.split(ref.full).join(ref.full.replace(src, nu));
  }

  return { content: out, uploaded: uploaded, failed: failed };
`;

/**
 * 构造在 page.evaluate 里执行的转存脚本（async IIFE 字符串）。
 * content / spec / skip 以 JSON 注入，避免任何转义/注入问题。
 */
export function buildTransferImagesJs(content, spec, skip) {
    return (
        '(async () => {\n' +
        'const content = ' + JSON.stringify(content) + ';\n' +
        'const spec = ' + JSON.stringify(spec || {}) + ';\n' +
        'const skip = ' + JSON.stringify(skip || []) + ';\n' +
        IN_PAGE_BODY +
        '\n})()'
    );
}

const MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
};

/**
 * 判断一个图片 src 是否指向【本机文件系统的绝对路径】（而非可被浏览器 fetch 的 URL）。
 * 页面内 fetch 只能解析 http(s)/data/blob 等 URL；本机绝对路径（如 /tmp/x.png）会被当成
 * 站点相对 URL → 404。所以这类 src 必须在 Node 侧先读成 data: URI 再注入页面。纯函数。
 */
export function isLocalImagePath(src) {
    if (typeof src !== 'string' || !src) return false;
    if (src.startsWith('file://')) return true;
    if (/^[a-zA-Z]:[\\/]/.test(src)) return true;          // Windows 盘符 C:\ 或 C:/
    if (src.startsWith('//')) return false;                // 协议相对 URL
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(src)) return false; // 其它 URI scheme（http: data: blob: …）
    if (src.startsWith('/')) return true;                  // Unix 绝对路径
    return false;                                          // 相对路径视为站点相对，不当本机文件
}

function localPathFromSrc(src) {
    if (src.startsWith('file://')) {
        try { return fileURLToPath(src); } catch { return src.slice('file://'.length); }
    }
    return src;
}

/**
 * Node 侧：把单个【本机图片路径】读成 base64 data: URI。
 * 供正文之外的单图参数（如 --cover 封面）复用与 inlineLocalImages 相同的读取逻辑。
 * 读不到时抛错（单图参数是用户显式意图，不能静默降级）。
 *
 * @param {string} src  本机绝对路径或 file:// URL
 * @param {{ readFile?: (p: string) => Promise<Uint8Array|Buffer> }} [deps]
 * @returns {Promise<{ dataUri: string, bytes: number, mime: string }>}
 */
export async function localImageToDataUri(src, deps = {}) {
    const read = deps.readFile || readFile;
    const p = localPathFromSrc(src);
    const buf = await read(p);
    const bytes = buf.byteLength != null ? buf.byteLength : buf.length;
    const ext = (p.split(/[\\/]/).pop().split('.').pop() || '').toLowerCase().split('?')[0];
    const mime = MIME_BY_EXT[ext] || 'image/png';
    return { dataUri: `data:${mime};base64,${Buffer.from(buf).toString('base64')}`, bytes, mime };
}

/**
 * Node 侧：把正文里引用的【本机图片路径】读成 base64 data: URI，原地替换回正文。
 * 这样注入页面后，平台的图片转存（binary-multipart / 自定义 uploadFn）就能 fetch 到字节
 * 并转存到平台图床——否则本机路径在页面里会被当成站点相对 URL、直接 404（图全裂）。
 * 只处理本机绝对路径；http(s)/data/相对 URL 一律原样保留，交给页面内转存或平台自处理。
 *
 * @param {string} content  文章正文（Markdown 或 HTML）
 * @param {{ readFile?: (p: string) => Promise<Uint8Array|Buffer> }} [deps]  便于测试注入
 * @returns {Promise<{ content: string, inlined: Array<{src:string,bytes:number,mime:string}>, missing: Array<{src:string,error:string}> }>}
 */
export async function inlineLocalImages(content, deps = {}) {
    const read = deps.readFile || readFile;
    const inlined = [];
    const missing = [];
    if (typeof content !== 'string' || !content) return { content: content || '', inlined, missing };
    const refs = extractImageRefs(content);
    const cache = {};
    let out = content;
    for (const ref of refs) {
        const src = ref.src;
        if (!isLocalImagePath(src)) continue;
        if (!(src in cache)) {
            try {
                const p = localPathFromSrc(src);
                const buf = await read(p);
                const bytes = buf.byteLength != null ? buf.byteLength : buf.length;
                const ext = (p.split(/[\\/]/).pop().split('.').pop() || '').toLowerCase().split('?')[0];
                const mime = MIME_BY_EXT[ext] || 'image/png';
                const b64 = Buffer.from(buf).toString('base64');
                cache[src] = `data:${mime};base64,${b64}`;
                inlined.push({ src, bytes, mime });
            } catch (e) {
                cache[src] = null;
                missing.push({ src, error: String((e && e.message) || e) });
            }
        }
        const du = cache[src];
        if (du) out = out.split(ref.full).join(ref.full.replace(src, du));
    }
    return { content: out, inlined, missing };
}

/**
 * 在平台页面里把正文图片全部转存到本平台图床，返回改写后的正文 + 转存报告。
 * 调用前 page 必须已经导航到该平台的写作 origin（cookie / Origin 才正确）。
 *
 * @param {{ evaluate: (js: string) => Promise<any> }} page  opencli 的 page 句柄
 * @param {string} content  文章正文（HTML 或 Markdown）
 * @param {{ spec: object, skip?: string[] }} options  平台上传声明
 * @returns {Promise<{ content: string, uploaded: Array, failed: Array }>}
 */
export async function transferImages(page, content, options = {}) {
    const { spec, skip = [] } = options;
    if (!spec || !spec.url) {
        // 没声明上传 spec：原样返回，不报错（有些平台正文不带图）。
        return { content, uploaded: [], failed: [] };
    }
    if (extractImageRefs(content).length === 0) {
        return { content, uploaded: [], failed: [] };
    }
    const result = await page.evaluate(buildTransferImagesJs(content, spec, skip));
    return result || { content, uploaded: [], failed: [] };
}

export const __test__ = {
    extractImageRefs,
    pickPath,
    buildTransferImagesJs,
    isLocalImagePath,
    inlineLocalImages,
    localImageToDataUri,
    HTML_IMG_RE,
    MD_IMG_RE,
};
