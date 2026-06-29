/**
 * Kuaishou (快手) video publish — creator-center UI automation.
 *
 * Faithfully ported from upstream social-auto-upload ks_uploader (KSVideo.upload):
 *   1. open cp.kuaishou.com/article/publish/video
 *   2. pick the video file (upload trigger → file input)
 *   3. dismiss the "我知道了" hint and the react-joyride guide overlay
 *   4. fill the 描述 editor (desc or title) + up to 3 #topics
 *   5. wait until "上传中" disappears (retry on "上传失败")
 *   6. optional cover (封面设置) + optional scheduled publish time
 *   7. click 发布 → 确认发布, confirm by landing on the /article/manage page
 *
 * One command does the whole flow. Requires being logged into cp.kuaishou.com.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  resolveVideoFile, resolveImageFile, setVideoInput, unwrap, currentUrl, parseScheduleDate,
  clickByText, countByText, existsByText, waitForUrlIncludes, waitForSelector,
} from '../_shared/video-publish.js';

const UPLOAD_URL = 'https://cp.kuaishou.com/article/publish/video';
const UPLOAD_BUTTON_SELECTOR = "button[class^='_upload-btn']";
const VIDEO_INPUT_SELECTORS = [
  "input[class^='upload-btn-input']",
  "div.progress-div [class^='upload-btn-input']",
  "button[class^='_upload-btn'] input[type='file']",
  "input[type='file']",
];


// Fill the 描述 contenteditable: click the div right after the "描述" label,
// clear it, then type via CDP. Mirrors ks_uploader keyboard sequence.
async function fillDescription(page, text) {
  const focused = Boolean(unwrap(await page.evaluate(`
    (() => {
      const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
      let label = null;
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length) continue;
        if (norm(el.innerText || el.textContent) === '描述') { label = el; break; }
      }
      if (!label) return false;
      // get_by_text("描述").locator("xpath=following-sibling::div")
      let sib = label.nextElementSibling;
      while (sib && sib.tagName !== 'DIV') sib = sib.nextElementSibling;
      const target = sib || label.parentElement;
      if (!target) return false;
      target.click();
      const editable = target.querySelector('[contenteditable]') || target;
      editable.focus();
      return true;
    })()
  `)));
  if (!focused) {
    throw new CommandExecutionError('找不到快手「描述」输入框');
  }
  // Clear existing content (Backspace / Ctrl+A / Delete), then type.
  try { await page.pressKey('Backspace'); } catch { /* non-fatal */ }
  try { await page.pressKey('Control+a'); } catch { /* non-fatal */ }
  try { await page.pressKey('Delete'); } catch { /* non-fatal */ }
  await page.insertText(text);
  await page.pressKey('Enter');
}

async function setScheduleTime(page, dt) {
  const pad = (n) => String(n).padStart(2, '0');
  const publishDateStr = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} `
    + `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
  // 1. switch to the "定时发布" radio (text match is the stable anchor)
  await clickByText(page, '定时发布', { timeoutMs: 5000 });
  await page.wait({ time: 2 });
  // 2. open the picker dropdown
  await page.click('input[placeholder="选择日期时间"]');
  await page.wait({ time: 1 });
  // 3. set the input value the React-controlled way (native setter + events)
  const ok = Boolean(unwrap(await page.evaluate(`
    ((newValue) => {
      const input = document.querySelector('input[placeholder="选择日期时间"]');
      if (!input) return false;
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, newValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })(${JSON.stringify(publishDateStr)})
  `)));
  if (!ok) throw new CommandExecutionError('找不到快手定时发布时间选择器输入框');
  await page.wait({ time: 1 });
  // 4. confirm with Enter
  await page.pressKey('Enter');
  await page.wait({ time: 2 });
}

async function setThumbnail(page, thumbnailPath) {
  if (!thumbnailPath) return;
  // 封面设置 label → its following div → first inner div → click to open modal
  const opened = Boolean(unwrap(await page.evaluate(`
    (() => {
      const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
      let label = null;
      for (const el of document.querySelectorAll('span')) {
        if (norm(el.innerText || el.textContent).includes('封面设置')) { label = el; break; }
      }
      if (!label) return false;
      let sib = label.parentElement ? label.parentElement.nextElementSibling : label.nextElementSibling;
      while (sib && sib.tagName !== 'DIV') sib = sib.nextElementSibling;
      if (!sib) return false;
      const first = sib.querySelector('div') || sib;
      first.click();
      return true;
    })()
  `)));
  if (!opened) throw new CommandExecutionError('找不到快手「封面设置」入口');
  if (!await waitForSelector(page, 'div[role="document"].ant-modal', 30_000)) {
    throw new CommandExecutionError('封面设置弹窗未出现');
  }
  await clickByText(page, '上传封面', { exact: true, timeoutMs: 10_000 });
  await page.wait({ time: 0.5 });
  await setVideoInput(page, ['div[role="document"].ant-modal input[type="file"]', 'input[type="file"]'], [thumbnailPath]);
  await page.wait({ time: 1 });
  await clickByText(page, '确认', { exact: true, timeoutMs: 10_000 });
  // wait for modal to disappear
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const present = Boolean(unwrap(await page.evaluate(
      `(() => { const m = document.querySelector('div[role="document"].ant-modal'); return !!(m && m.getBoundingClientRect().width > 0); })()`,
    )));
    if (!present) break;
    await page.wait({ time: 0.5 });
  }
}

cli({
  site: 'kuaishou',
  name: 'publish',
  access: 'write',
  description: '发布视频到快手（一条命令完成上传+填写+发布；可选封面/定时/话题）',
  domain: 'cp.kuaishou.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'video', required: true, positional: true, help: '视频文件路径' },
    { name: 'title', required: true, help: '作品标题（无 --desc 时作为描述）' },
    { name: 'desc', default: '', help: '视频描述（默认用标题）' },
    { name: 'tags', default: '', help: '话题标签，逗号分隔，最多取前 3 个（不含 #）' },
    { name: 'cover', default: '', help: '封面图片路径（可选）' },
    { name: 'schedule', default: '', help: '定时发布时间（ISO8601 或 Unix 秒；不填即立即发布）' },
  ],
  columns: ['status', 'title', 'url'],
  func: async (page, kwargs) => {
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new ArgumentError('快手视频上传时，title 是必须的');
    const videoPath = resolveVideoFile(kwargs.video);
    const coverPath = kwargs.cover ? resolveImageFile(kwargs.cover) : '';
    const desc = String(kwargs.desc || '').trim() || title;
    const tags = kwargs.tags
      ? String(kwargs.tags).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const scheduleDate = parseScheduleDate(kwargs.schedule);

    // ── Navigate to the upload page ──────────────────────────────────────────
    await page.goto(UPLOAD_URL);
    if (!await waitForUrlIncludes(page, 'article/publish/video', 30_000)) {
      throw new CommandExecutionError('未能进入快手上传页（登录态可能失效，请先 opencli kuaishou login）');
    }
    if (!await waitForSelector(page, UPLOAD_BUTTON_SELECTOR, 15_000)) {
      throw new CommandExecutionError('快手上传按钮未出现');
    }

    // ── Select the video file ────────────────────────────────────────────────
    await setVideoInput(page, VIDEO_INPUT_SELECTORS, [videoPath]);
    await page.wait({ time: 2 });

    // ── Dismiss the "我知道了" hint + the react-joyride guide overlay ─────────
    if (await existsByText(page, '我知道了', { exact: true })) {
      await clickByText(page, '我知道了', { exact: true });
    }
    // react-joyride overlay skip button
    await page.evaluate(`
      (() => {
        const tip = document.querySelector('div[id^="react-joyride-step"] div[role="alertdialog"]');
        if (!tip) return false;
        const skip = document.querySelector('div[role="alertdialog"] [aria-label="Skip"], div[role="alertdialog"] [data-action="skip"], div[role="alertdialog"] button[title="Skip"]');
        if (skip) { skip.click(); return true; }
        return false;
      })()
    `);

    // ── Fill description + topics ────────────────────────────────────────────
    await fillDescription(page, desc);
    for (const tag of tags.slice(0, 3)) {
      await page.insertText(`#${tag} `);
      await page.wait({ time: 2 });
    }

    // ── Wait for upload to finish (retry on failure) ─────────────────────────
    const maxRetries = 60;
    for (let i = 0; i < maxRetries; i++) {
      const uploading = await countByText(page, '上传中');
      if (uploading === 0) break;
      if (await countByText(page, '上传失败') > 0) {
        // handle_upload_error: re-set the file on the progress input
        await setVideoInput(page, VIDEO_INPUT_SELECTORS, [videoPath]);
      }
      await page.wait({ time: 2 });
    }

    // ── Optional cover + scheduled time ──────────────────────────────────────
    if (coverPath) await setThumbnail(page, coverPath);
    if (scheduleDate) await setScheduleTime(page, scheduleDate);

    // ── Publish: 发布 → 确认发布 → confirm by landing on /article/manage ──────
    const publishDeadline = Date.now() + 60_000;
    let published = false;
    while (Date.now() < publishDeadline) {
      await clickByText(page, '发布', { exact: true });
      await page.wait({ time: 1 });
      await clickByText(page, '确认发布');
      if (await waitForUrlIncludes(page, 'article/manage', 5000)) {
        published = true;
        break;
      }
      await page.wait({ time: 1 });
    }
    if (!published) {
      throw new CommandExecutionError('快手发布未确认成功（未跳转到作品管理页），请检查页面状态');
    }

    return [{
      status: scheduleDate ? '✅ 定时发布已提交' : '✅ 发布成功',
      title,
      url: await currentUrl(page),
    }];
  },
});
