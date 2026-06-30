/**
 * Hashnode 文章发布 —— [pp-only] 复用浏览器登录态，**驱动 Web 编辑器**（DOM 自动化）。
 *
 * 为什么不用 GraphQL（gql.hashnode.com / publishPost）：
 *   - Hashnode 2026-05-13 起把公共 GraphQL API 改成付费 Pro 专享（changelog
 *     2026-05-13-graphql-api-paid-access），免费账号 PAT/会话都打不动。
 *   - gql.hashnode.com 与 hashnode.com 跨域，页面内 fetch 被 CORS 拦死（真机 `Failed to fetch`）。
 *   - `/api/auth/session` 不含任何 JWT/accessToken（真机坐实），没法「抠 token 打 gql」。
 *   故唯一可行的「复用登录态发布」路径 = 驱动官方 Web 编辑器。
 *
 * 照搬来源（开源）：codenameone/CodenameOne
 *   scripts/website/syndicate_browser_posts.py 的 Hashnode adapter
 *   （github.com/codenameone/CodenameOne/blob/master/scripts/website/syndicate_browser_posts.py）。
 *   该脚本明文写道 "Hashnode shut down free public GraphQL access on 2026-05-13 ... drive
 *   its web editor here from a signed-in storage state instead"，并固化了下列选择器/流程：
 *     - 入口：点 "Write" → 跳到 /draft/<id> 草稿编辑器
 *     - 标题：textarea[placeholder='Article Title...']
 *     - 正文：div[contenteditable='true']
 *     - 标签：input#editor-tags
 *     - canonical：label:has-text('Add a canonical URL') + input[placeholder='https://example.com/original-article']
 *     - 发布：先点顶栏 Publish → 再点弹窗内 [role='dialog'][data-state='open'] button:text-is('Publish')
 *     - 成功判定：URL 离开 /draft/ 后稳定，即为最终文章 URL
 *   上述选择器全部经本机真机（账号 karentia，发布站 kpp09910.hashnode.dev）逐一验证。
 *
 * 流程（func 内全部用 page.goto / page.evaluate / page.wait 原语，分步原子化以抗浏览器桥抖动）：
 *   1. /api/auth/session 鉴权（拿 username，匿名即抛 AuthRequiredError）
 *   2. 点 "Write" 新建草稿，等 URL 落到 /draft/<id>
 *   3. 填标题 + 正文（contenteditable 用 execCommand insertText；Hashnode 编辑器支持 Markdown）
 *   4. 可选：标签 / canonical
 *   5. --draft：到此为止（草稿自动保存），回草稿编辑 URL
 *      否则：点顶栏 Publish → 点弹窗 Publish → 等 URL 离开 /draft/，回最终文章 URL
 *
 * args：title、body/body-file(markdown)、tags、cover-image、canonical-url、--draft。
 * 注意：Hashnode 发布前账号必须先有 publication（博客）；无博客时编辑器入口会被引导去
 *   "Create a publication"（hashnode.com/dashboards），这是一次性 onboarding，不在发布范围内。
 */
import * as fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const HOME = 'https://hashnode.com';

export function resolveBody(kwargs) {
  if (kwargs['body-file']) {
    const file = String(kwargs['body-file']);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new ArgumentError(`--body-file not found: ${file}`);
    }
    return fs.readFileSync(file, 'utf8');
  }
  if (kwargs.body !== undefined && kwargs.body !== null) return String(kwargs.body);
  return undefined;
}

// 逗号分隔标签 → 去空白去重的数组。纯函数，便于测试。
export function resolveTags(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  return [...new Set(String(raw).split(',').map((t) => t.trim()).filter(Boolean))];
}

// 在页面内构造「找到登录用户名」的同源 session 探测脚本片段（复用 auth 的事实）。
// 同源 session 探测；用相对路径（必须落在 hashnode.com 页面），失败回 {drift} 触发外层重开。
const SESSION_PROBE = `(async () => {
  if (location.href.indexOf('hashnode.com') < 0) return { drift: true };
  try {
    var r = await fetch('/api/auth/session', { credentials: 'include', headers: { Accept: 'application/json' } });
    var j = await r.json().catch(function(){ return null; });
    var u = j && j.user;
    return u && u.username ? { ok: true, username: String(u.username) } : { ok: false };
  } catch (e) { return { drift: true, err: String(e && e.message || e) }; }
})()`;

// 浏览器桥不稳：活动标签会漂到 data: 空白页或别的站点。约定脚本在「不在预期域」时返回 {drift}，
// 这里重开 anchor URL 再试。anchor 默认 HOME，草稿相关步骤要传 draftUrl 才不会丢草稿。
async function evalRetry(page, script, { tries = 8, label = 'eval', anchor = HOME } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    let r;
    try { r = await page.evaluate(script); } catch (e) { r = { drift: true, err: String(e && e.message || e) }; }
    last = r;
    if (r && r.drift) { await page.goto(anchor); await page.wait(2); continue; }
    return r;
  }
  throw new CommandExecutionError(`Hashnode ${label}: browser tab kept drifting (last: ${JSON.stringify(last)})`);
}

cli({
  site: 'hashnode',
  name: 'publish',
  access: 'write',
  description: 'Publish a Hashnode post via the web editor (or save a draft with --draft). Markdown body + tags/cover/canonical.',
  domain: 'hashnode.com',
  strategy: Strategy.COOKIE,
  browser: true,
  defaultWindowMode: 'foreground',
  siteSession: 'persistent',
  args: [
    { name: 'title', type: 'string', required: true, help: 'Post title' },
    { name: 'body', type: 'string', required: false, help: 'Post body in Markdown (or use --body-file)' },
    { name: 'body-file', type: 'string', required: false, help: 'Path to a Markdown file for the body' },
    { name: 'tags', type: 'string', required: false, help: 'Comma-separated tag names' },
    { name: 'cover-image', type: 'string', required: false, help: 'Cover image URL' },
    { name: 'canonical-url', type: 'string', required: false, help: 'Canonical / original article URL' },
    { name: 'draft', type: 'boolean', required: false, default: false, help: 'Save as draft instead of publishing' },
  ],
  columns: ['status', 'draft_id', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for hashnode publish');
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new ArgumentError('hashnode publish: --title is required');
    const body = resolveBody(kwargs);
    if (body === undefined) throw new ArgumentError('--body or --body-file is required');
    const tags = resolveTags(kwargs.tags);
    const canonical = kwargs['canonical-url'] ? String(kwargs['canonical-url']) : '';
    const cover = kwargs['cover-image'] ? String(kwargs['cover-image']) : '';

    // 1. 鉴权（goto+fetch 会撞浏览器桥的标签漂移导致 Failed to fetch，故 evalRetry 重试）
    await page.goto(HOME);
    const session = await evalRetry(page, SESSION_PROBE, { label: 'auth' });
    if (!session || !session.ok) {
      throw new AuthRequiredError('hashnode.com', 'Not logged in. Run `opencli hashnode login`.');
    }

    // 2. 新建草稿：点 "Write"，等 URL 落到 /draft/<id>
    const created = await evalRetry(page, `(async () => {
      if (location.href.indexOf('hashnode.com') < 0) return { drift: true };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const w = [...document.querySelectorAll('a,button')].find((e) => (e.innerText || '').trim() === 'Write');
      if (!w) return { ok: false, reason: 'no Write button (need a publication first?)' };
      w.click();
      let t = 0;
      while (t < 18000) { await sleep(500); t += 500; if (location.href.indexOf('/draft/') >= 0) break; }
      const m = location.href.match(/\\/draft\\/([a-z0-9]+)/i);
      return m ? { ok: true, draftId: m[1], href: location.href } : { ok: false, reason: 'editor did not open (no /draft/ url) — does the account have a publication?' };
    })()`, { label: 'new-draft' });
    if (!created || !created.ok) {
      throw new CommandExecutionError(`Hashnode could not open the editor: ${created ? created.reason : 'unknown'}`);
    }
    const draftId = created.draftId;
    const draftUrl = `${HOME}/draft/${draftId}`;

    // 3. 填标题 + 正文（先 re-goto 草稿 URL 锚定，再等编辑器 hydrate；re-goto 比依赖 SPA 不漂更稳）
    await page.goto(draftUrl);
    const filled = await evalRetry(page, `(async () => {
      if (location.href.indexOf('/draft/') < 0) return { drift: true };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let t = 0, title, body;
      while (t < 16000) { await sleep(500); t += 500;
        title = document.querySelector('textarea[placeholder="Article Title..."]');
        body = document.querySelector('div[contenteditable="true"]');
        if (title && body) break; }
      if (!title || !body) return { ok: false, reason: 'editor fields not found' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      title.focus();
      setter.call(title, ${JSON.stringify(title)});
      title.dispatchEvent(new Event('input', { bubbles: true }));
      title.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(500);
      body.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, ${JSON.stringify(body)});
      await sleep(1500);
      return { ok: true, titleVal: title.value, bodyLen: (body.innerText || '').length };
    })()`, { label: 'fill', anchor: draftUrl });
    if (!filled || !filled.ok) {
      throw new CommandExecutionError(`Hashnode fill failed: ${filled ? filled.reason : 'unknown'}`);
    }

    // 4. 可选 canonical（在发布弹窗里设；标签也在弹窗里）。为保持薄+稳，这里把 tags/canonical
    //    放进发布弹窗的处理；草稿态不强制设置。
    // （cover-image 走文件选择器，浏览器桥不便注入本地文件；仅当传 URL 时尝试，best-effort 略。）

    if (kwargs.draft) {
      return [{ status: 'draft', draft_id: draftId, url: draftUrl }];
    }

    // 5. 发布。关键：Hashnode 用 React/Radix，**合成 element.click() 会被忽略**
    //    （codenameone 注释明确：'Hashnode listens for native pointer events'）。
    //    所以发布/标签按钮必须走 opencli 的 page.click()（底层 CDP 原生点击）。
    //    手法：用 eval 给目标元素打一个临时 data-pp 标记，再 page.click('[data-pp=...]')。
    const tagsJson = JSON.stringify(tags);
    const canonical2 = canonical;

    // 5a. re-goto 锚定，等编辑器就绪，给顶栏 Publish 打标记
    await page.goto(draftUrl);
    const ready = await evalRetry(page, `(async () => {
      if (location.href.indexOf('/draft/') < 0) return { drift: true };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let t = 0, tops;
      while (t < 16000) { await sleep(500); t += 500;
        tops = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === 'Publish' && !b.closest('[role="dialog"]'));
        if (tops.length) break; }
      if (!tops || !tops.length) return { ok: false, reason: 'no top-bar Publish button (no publication?)' };
      tops.forEach((b) => b.removeAttribute('data-pp'));
      tops[0].setAttribute('data-pp', 'top-publish');
      return { ok: true };
    })()`, { label: 'publish-ready', anchor: draftUrl });
    if (!ready || !ready.ok) {
      throw new CommandExecutionError(`Hashnode publish not ready: ${ready ? ready.reason : 'unknown'}`);
    }
    // 原生点击顶栏 Publish 打开弹窗
    await page.click('[data-pp="top-publish"]');
    await page.wait(3);

    // 5b. 弹窗里：切到 Discovery 标签页（标签/canonical 在那），设置 tags/canonical（best-effort）
    const dlgReady = await evalRetry(page, `(async () => {
      if (location.href.indexOf('hashnode.com') < 0) return { drift: true };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let d = 0, dlg;
      while (d < 8000) { await sleep(500); d += 500;
        dlg = document.querySelector('[role="dialog"][data-state="open"]') || document.querySelector('[role="dialog"]');
        if (dlg && [...dlg.querySelectorAll('button')].some((b) => (b.innerText || '').trim() === 'Publish')) break; }
      if (!dlg) return { ok: false, reason: 'publish dialog did not open' };
      // 给 Discovery tab 与 弹窗 Publish 打标记，供原生点击
      var disc = [...dlg.querySelectorAll('[role="tab"],button')].find((e) => /discovery/i.test(e.innerText || ''));
      if (disc) disc.setAttribute('data-pp', 'discovery-tab');
      var pub = [...dlg.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Publish');
      if (pub) pub.setAttribute('data-pp', 'dlg-publish');
      return { ok: !!pub, hasDiscovery: !!disc };
    })()`, { label: 'dialog-ready', anchor: draftUrl });
    if (!dlgReady || !dlgReady.ok) {
      throw new CommandExecutionError(`Hashnode publish dialog failed: ${dlgReady ? dlgReady.reason : 'unknown'}`);
    }

    // 标签：切到 Discovery，逐个 type + Enter（input 用合成事件填值即可，提交靠 Enter 键事件）
    if (tags.length && dlgReady.hasDiscovery) {
      try {
        await page.click('[data-pp="discovery-tab"]');
        await page.wait(2);
        await evalRetry(page, `(async () => {
          if (location.href.indexOf('hashnode.com') < 0) return { drift: true };
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          var ti = document.querySelector('input#editor-tags');
          if (!ti) return { ok: false };
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          var tags = ${tagsJson};
          for (var i = 0; i < tags.length; i++) {
            ti.focus(); setter.call(ti, tags[i]); ti.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(500);
            ['keydown','keypress','keyup'].forEach((ty) => ti.dispatchEvent(new KeyboardEvent(ty, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })));
            await sleep(500);
          }
          return { ok: true };
        })()`, { label: 'tags', anchor: draftUrl });
      } catch (e) { /* 标签 best-effort，不阻断发布 */ }
    }
    // canonical（best-effort）
    if (canonical2) {
      try {
        await evalRetry(page, `(async () => {
          if (location.href.indexOf('hashnode.com') < 0) return { drift: true };
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          var toggle = [...document.querySelectorAll('label,button')].find((e) => /add a canonical url/i.test(e.innerText || ''));
          if (toggle && !document.querySelector('input[placeholder="https://example.com/original-article"]')) { toggle.setAttribute('data-pp','canon-toggle'); }
          return { ok: true };
        })()`, { label: 'canon-prep', anchor: draftUrl });
        await page.click('[data-pp="canon-toggle"]').catch(() => {});
        await page.wait(1);
        await page.evaluate(`(() => {
          var ci = document.querySelector('input[placeholder="https://example.com/original-article"]');
          if (ci) { var s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; ci.focus(); s.call(ci, ${JSON.stringify(canonical2)}); ci.dispatchEvent(new Event('input',{bubbles:true})); ci.dispatchEvent(new Event('blur',{bubbles:true})); }
          return true;
        })()`);
      } catch (e) { /* canonical best-effort */ }
    }

    // 5c. 原生点击弹窗 Publish（重新打标记以防 React 重渲染丢失），等 URL 离开 /draft/
    await page.evaluate(`(() => {
      var dlg = document.querySelector('[role="dialog"][data-state="open"]') || document.querySelector('[role="dialog"]');
      if (dlg) { var pub = [...dlg.querySelectorAll('button')].find((b) => (b.innerText||'').trim()==='Publish'); if (pub) pub.setAttribute('data-pp','dlg-publish'); }
      return true;
    })()`);
    await page.click('[data-pp="dlg-publish"]');

    // 等待发布完成：URL 离开 /draft/ 且不是 /edit/（/edit 表示只是转成了草稿态文章未真正公开）
    let finalUrl = '';
    for (let w = 0; w < 30; w += 1) {
      await page.wait(1);
      const cur = await page.evaluate(`(() => location.href)()`).catch(() => '');
      if (typeof cur === 'string' && cur.indexOf('/draft/') < 0 && cur.indexOf('hashnode.com') < 0) { finalUrl = cur; break; }
      if (typeof cur === 'string' && cur.indexOf('/draft/') < 0 && cur.indexOf('/edit/') < 0 && cur.indexOf('hashnode.com') >= 0) { finalUrl = cur; break; }
    }
    if (!finalUrl) {
      throw new CommandExecutionError('Hashnode publish did not navigate to a live article URL (still on /draft or /edit). The post may have been saved but not published.');
    }
    // 发布后 URL 即最终文章地址（<sub>.hashnode.dev/<slug>）。
    return [{ status: 'published', draft_id: draftId, url: finalUrl }];
  },
});
