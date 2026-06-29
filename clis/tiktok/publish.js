/**
 * TikTok video publish — TikTok Studio (creator center) UI automation.
 *
 * Faithfully ported from upstream social-auto-upload tk_uploader (TiktokVideo.upload):
 *   1. open tiktok.com/creator-center/upload → tiktokstudio/upload
 *   2. pick the video file (Select video → file input)
 *   3. fill the caption editor (Draft.js) with title + #tags
 *   4. wait until the post button enables (retry file pick on error)
 *   5. optional scheduled publish time (TUX date/time picker)
 *   6. click 发布 (div.btn-post), confirm via the success indicator
 *
 * One command does the whole flow. Requires being logged into tiktok.com.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  resolveVideoFile, setVideoInput, unwrap, parseScheduleDate,
  waitForUrlIncludes, waitForSelector,
} from '../_shared/video-publish.js';

const ENTRY_URL = 'https://www.tiktok.com/creator-center/upload';
const VIDEO_INPUT_SELECTORS = ['input[type="file"][accept*="video"]', 'input[type="file"]'];
const EDITOR_SELECTOR = 'div.public-DraftEditor-content';
const POST_BUTTON_SELECTOR = 'div.btn-post';
const SUCCESS_FLAG_SELECTOR = '#\\:r9\\:';


async function selectorExists(page, selector) {
  return Boolean(unwrap(await page.evaluate(
    `((s) => !!document.querySelector(s))(${JSON.stringify(selector)})`,
  )));
}

// ── Caption editor (Draft.js): clear then type title + tags ──────────────────
async function addTitleTags(page, title, tags) {
  await page.click(EDITOR_SELECTOR);
  await page.pressKey('End');
  await page.pressKey('Control+a');
  await page.pressKey('Delete');
  await page.pressKey('End');
  await page.wait({ time: 1 });
  await page.insertText(title);
  await page.wait({ time: 1 });
  await page.pressKey('End');
  await page.pressKey('Enter');
  // tag part — mirror the upstream End / insert / Space / Backspace / End dance
  for (const tag of tags) {
    await page.pressKey('End');
    await page.wait({ time: 1 });
    await page.insertText(`#${tag} `);
    await page.pressKey('Space');
    await page.wait({ time: 1 });
    await page.pressKey('Backspace');
    await page.pressKey('End');
  }
}

// ── Wait until the post button is enabled (upload finished) ───────────────────
async function detectUploadStatus(page, videoPath) {
  const deadline = Date.now() + 30 * 60 * 1000; // generous; upstream loops unbounded
  while (Date.now() < deadline) {
    const enabled = unwrap(await page.evaluate(`
      (() => {
        const btn = document.querySelector('${POST_BUTTON_SELECTOR} > button');
        if (!btn) return null;
        return btn.getAttribute('disabled') === null;
      })()
    `));
    if (enabled === true) return;
    // error path: a "Select file" button reappears → re-pick the file
    if (await selectorExists(page, 'button[aria-label="Select file"]')) {
      await setVideoInput(page, ['button[aria-label="Select file"] ~ input[type="file"]', ...VIDEO_INPUT_SELECTORS], [videoPath]);
    }
    await page.wait({ time: 2 });
  }
  throw new CommandExecutionError('TikTok 视频上传超时');
}

// ── Scheduled publish (TUX date/time picker) ─────────────────────────────────
async function setScheduleTime(page, dt) {
  // Switch on the Schedule option
  const scheduleClicked = Boolean(unwrap(await page.evaluate(`
    (() => {
      const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
      // get_by_label('Schedule')
      let el = document.querySelector('[aria-label="Schedule"]');
      if (!el) {
        for (const lbl of document.querySelectorAll('label, [role="radio"], button, div, span')) {
          if (norm(lbl.innerText || lbl.textContent) === 'Schedule') { el = lbl; break; }
        }
      }
      if (!el) return false;
      el.click();
      return true;
    })()
  `)));
  if (!scheduleClicked) throw new CommandExecutionError('找不到 TikTok 定时发布开关 (Schedule)');
  await page.wait({ time: 1 });

  const pad = (n) => String(n).padStart(2, '0');
  const targetDay = dt.getDate();
  const targetMonth = dt.getMonth() + 1;
  const hourStr = pad(dt.getHours());
  const minuteStr = pad(Math.floor(dt.getMinutes() / 5)); // upstream rounds to 5-min slots

  // Open the date box (scheduled-picker → TUXInputBox nth(1)), navigate months,
  // pick the day; then open the time box (nth(0)) and pick hour + minute.
  const result = unwrap(await page.evaluate(`
    ((targetDay, targetMonth) => {
      const picker = document.querySelector('div.scheduled-picker');
      if (!picker) return { ok: false, reason: 'no scheduled-picker' };
      const boxes = picker.querySelectorAll('div.TUXInputBox');
      if (boxes.length < 2) return { ok: false, reason: 'no TUXInputBox' };
      boxes[1].click(); // open the date calendar
      const monthTitle = document.querySelector('div.calendar-wrapper span.month-title');
      const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      let curMonth = monthTitle ? (MONTHS.indexOf((monthTitle.innerText || '').trim()) + 1) : 0;
      return { ok: true, curMonth };
    })(${targetDay}, ${targetMonth})
  `));
  if (!result?.ok) throw new CommandExecutionError(`TikTok 定时选择器异常: ${result?.reason || 'unknown'}`);
  // navigate month arrows if needed
  if (result.curMonth && result.curMonth !== targetMonth) {
    const dir = result.curMonth < targetMonth ? 'last' : 'first';
    await page.evaluate(`
      (() => {
        const arrows = document.querySelectorAll('div.calendar-wrapper span.arrow');
        if (!arrows.length) return false;
        const a = ${dir === 'last' ? 'arrows[arrows.length - 1]' : 'arrows[0]'};
        a.click();
        return true;
      })()
    `);
    await page.wait({ time: 0.5 });
  }
  // pick the day
  await page.evaluate(`
    ((wantDay) => {
      const days = document.querySelectorAll('div.calendar-wrapper span.day.valid');
      for (const d of days) {
        if ((d.innerText || '').trim() === String(wantDay)) { d.click(); return true; }
      }
      return false;
    })(${targetDay})
  `);
  // open the time box
  await page.evaluate(`
    (() => {
      const picker = document.querySelector('div.scheduled-picker');
      const boxes = picker ? picker.querySelectorAll('div.TUXInputBox') : [];
      if (boxes[0]) boxes[0].click();
    })()
  `);
  // pick the hour
  await page.evaluate(`
    ((hourStr) => {
      for (const el of document.querySelectorAll('span.tiktok-timepicker-left')) {
        if ((el.innerText || '').includes(hourStr)) { el.click(); return true; }
      }
      return false;
    })(${JSON.stringify(hourStr)})
  `);
  await page.wait({ time: 1 });
  // re-open the time box and pick the minute
  await page.evaluate(`
    (() => {
      const picker = document.querySelector('div.scheduled-picker');
      const boxes = picker ? picker.querySelectorAll('div.TUXInputBox') : [];
      if (boxes[0]) boxes[0].click();
    })()
  `);
  await page.evaluate(`
    ((minuteStr) => {
      for (const el of document.querySelectorAll('span.tiktok-timepicker-right')) {
        if ((el.innerText || '').includes(minuteStr)) { el.click(); return true; }
      }
      return false;
    })(${JSON.stringify(minuteStr)})
  `);
  // click the title to drop focus (mirror upstream)
  await page.evaluate(`
    (() => {
      for (const h of document.querySelectorAll('h1')) {
        if ((h.innerText || '').includes('Upload video')) { h.click(); return true; }
      }
      return false;
    })()
  `);
}

// ── Publish ──────────────────────────────────────────────────────────────────
async function clickPublish(page) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await selectorExists(page, POST_BUTTON_SELECTOR)) {
      await page.evaluate(`(() => { const b = document.querySelector('${POST_BUTTON_SELECTOR}'); if (b) b.click(); })()`);
    }
    await page.wait({ time: 1 });
    if (await selectorExists(page, SUCCESS_FLAG_SELECTOR)) return;
    await page.wait({ time: 0.5 });
  }
  // final check
  if (await selectorExists(page, SUCCESS_FLAG_SELECTOR)) return;
  throw new CommandExecutionError('TikTok 发布未确认成功（未出现成功标识）');
}

cli({
  site: 'tiktok',
  name: 'publish',
  access: 'write',
  description: 'Publish a video to TikTok (one command: upload + caption + publish; optional schedule)',
  domain: 'www.tiktok.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'video', required: true, positional: true, help: 'Video file path' },
    { name: 'title', required: true, help: 'Caption / title text' },
    { name: 'tags', default: '', help: 'Comma-separated hashtags (without #)' },
    { name: 'schedule', default: '', help: 'Scheduled publish time (ISO8601 or Unix seconds); omit to post now' },
  ],
  columns: ['status', 'title', 'url'],
  func: async (page, kwargs) => {
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new ArgumentError('--title is required');
    const videoPath = resolveVideoFile(kwargs.video);
    const tags = kwargs.tags
      ? String(kwargs.tags).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const scheduleDate = parseScheduleDate(kwargs.schedule);

    // ── Navigate ─────────────────────────────────────────────────────────────
    await page.goto(ENTRY_URL);
    if (!await waitForUrlIncludes(page, 'tiktokstudio/upload', 30_000)) {
      throw new CommandExecutionError('未能进入 TikTok Studio 上传页（登录态可能失效，请先 opencli tiktok login）');
    }
    // wait for either the iframe or the upload container
    await waitForSelector(page, 'iframe[data-tt="Upload_index_iframe"], div.upload-container', 10_000);

    // ── Select the video file (Select video button reveals the file input) ───
    await waitForSelector(page, 'input[type="file"]', 15_000);
    await setVideoInput(page, VIDEO_INPUT_SELECTORS, [videoPath]);

    // ── Caption + tags ───────────────────────────────────────────────────────
    if (!await waitForSelector(page, EDITOR_SELECTOR, 60_000)) {
      throw new CommandExecutionError('TikTok 文案编辑器未出现');
    }
    await addTitleTags(page, title, tags);

    // ── Wait for upload, then optional schedule, then publish ────────────────
    await detectUploadStatus(page, videoPath);
    if (scheduleDate) await setScheduleTime(page, scheduleDate);
    await clickPublish(page);

    return [{
      status: scheduleDate ? '✅ Scheduled' : '✅ Published',
      title,
      url: await page.evaluate('() => location.href').then(unwrap),
    }];
  },
});
