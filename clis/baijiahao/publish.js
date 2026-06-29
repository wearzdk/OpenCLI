/**
 * Baijiahao (百家号) video publish — creator-center UI automation.
 *
 * Faithfully ported from upstream social-auto-upload baijiahao_uploader
 * (BaiJiaHaoVideo.upload):
 *   1. open builder/rc/edit?type=videoV2, pick the video file
 *   2. wait for the publish form, fill the title (placeholder anchor)
 *   3. wait until the upload overlay clears, wait for the cover image
 *   4. publish now (button 发布) or schedule (定时发布 + time pickers)
 *   5. fail on the 百度安全验证 captcha; confirm by landing on builder/rc/clue
 *
 * One command does the whole flow. Requires being logged into baijiahao.baidu.com.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  resolveVideoFile, setVideoInput, unwrap, currentUrl, parseScheduleDate,
  clickByText, waitForUrlIncludes, waitForSelector,
} from '../_shared/video-publish.js';

const EDIT_URL = 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2';
const VIDEO_INPUT_SELECTORS = ["div[class^='video-main-container'] input", "input[type='file']"];


// add_title_tags: title <= 8 chars → append " 你不知道的"; fill placeholder, max 30.
async function addTitle(page, rawTitle) {
  let title = rawTitle;
  if (title.length <= 8) title += ' 你不知道的';
  title = title.slice(0, 30);
  const ok = Boolean(unwrap(await page.evaluate(`
    ((text) => {
      const input = document.querySelector('input[placeholder="添加标题获得更多推荐"], textarea[placeholder="添加标题获得更多推荐"], [placeholder*="添加标题"]');
      if (!input) return false;
      input.focus();
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(input, text); else input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })(${JSON.stringify(title)})
  `)));
  if (!ok) throw new CommandExecutionError('找不到百家号标题输入框');
  return title;
}

// uploading_video: poll the cover overlay; fail on 上传失败, wait on 上传中.
async function waitUploadingVideo(page) {
  const deadline = Date.now() + 300_000; // upstream async_retry timeout=300
  while (Date.now() < deadline) {
    const state = unwrap(await page.evaluate(`
      (() => {
        const has = (txt) => Array.from(document.querySelectorAll('div .cover-overlay'))
          .some((el) => (el.innerText || el.textContent || '').includes(txt));
        if (has('上传失败')) return 'failed';
        if (has('上传中')) return 'uploading';
        return 'done';
      })()
    `));
    if (state === 'failed') return false;
    if (state === 'done') return true;
    await page.wait({ time: 2 });
  }
  return false;
}

// set_schedule_time: 百家号 ant-style cheetah selects (date / hour). Mirrors the
// upstream (deliberately loose) flow, including its random hour pick.
async function setScheduleTime(page, dt) {
  const day = dt.getDate();
  const month = dt.getMonth() + 1;
  const publishDateDay = day > 9 ? `${month}月${day}日` : `${month}月0${day}日`;

  if (!await waitForSelector(page, 'div.select-wrap', 5000)) {
    throw new CommandExecutionError('百家号定时选择器未出现');
  }
  // open the date select (retry once)
  for (let i = 0; i < 3; i++) {
    await page.evaluate(`(() => { const w = document.querySelectorAll('div.select-wrap')[0]; if (w) w.click(); })()`);
    if (await waitForSelector(page, 'div.rc-virtual-list div.cheetah-select-item', 5000)) break;
  }
  await page.wait({ time: 2 });
  // pick the day
  await page.evaluate(`
    ((wantDay) => {
      for (const el of document.querySelectorAll('div.rc-virtual-list div.cheetah-select-item')) {
        if ((el.innerText || el.textContent || '').includes(wantDay)) { el.click(); return true; }
      }
      return false;
    })(${JSON.stringify(publishDateDay)})
  `);
  await page.wait({ time: 2 });
  // open the hour select (retry once)
  for (let i = 0; i < 3; i++) {
    await page.evaluate(`(() => { const w = document.querySelectorAll('div.select-wrap')[1]; if (w) w.click(); })()`);
    if (await waitForSelector(page, 'div.rc-virtual-list div.rc-virtual-list-holder-inner', 5000)) break;
  }
  await page.wait({ time: 2 });
  // upstream picks a random visible hour option (nth in [1, count-3))
  await page.evaluate(`
    (() => {
      const opts = Array.from(document.querySelectorAll('div.rc-virtual-list div.cheetah-select-item-option'))
        .filter((el) => el.offsetParent !== null);
      if (!opts.length) return false;
      const max = Math.max(1, opts.length - 3);
      const idx = Math.min(opts.length - 1, Math.max(1, Math.floor(Math.random() * (max - 1)) + 1));
      opts[idx].click();
      return true;
    })()
  `);
  await page.wait({ time: 2 });
  await clickByText(page, '定时发布', { timeoutMs: 5000 });
}

async function setSchedulePublish(page, dt) {
  // click the 定时发布 button (op-btn-outter-content >> text=定时发布 → its button)
  const clicked = Boolean(unwrap(await page.evaluate(`
    (() => {
      const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
      for (const c of document.querySelectorAll('div.op-btn-outter-content')) {
        if (norm(c.innerText || c.textContent).includes('定时发布')) {
          const parent = c.parentElement;
          const btn = parent ? parent.querySelector('button') : c.querySelector('button');
          if (btn) { btn.click(); return true; }
        }
      }
      return false;
    })()
  `)));
  if (!clicked) throw new CommandExecutionError('找不到百家号「定时发布」入口');
  if (!await waitForSelector(page, 'div.select-wrap', 3000)) {
    throw new CommandExecutionError('百家号定时面板未展开');
  }
  await page.wait({ time: 2 });
  await setScheduleTime(page, dt);
}

cli({
  site: 'baijiahao',
  name: 'publish',
  access: 'write',
  description: '发布视频到百家号（一条命令完成上传+填写+发布；可选定时）',
  domain: 'baijiahao.baidu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'video', required: true, positional: true, help: '视频文件路径' },
    { name: 'title', required: true, help: '视频标题（不足 8 字会自动补「你不知道的」，截断到 30 字）' },
    { name: 'schedule', default: '', help: '定时发布时间（ISO8601 或 Unix 秒；不填即立即发布）' },
  ],
  columns: ['status', 'title', 'url'],
  func: async (page, kwargs) => {
    const rawTitle = String(kwargs.title ?? '').trim();
    if (!rawTitle) throw new ArgumentError('--title is required');
    const videoPath = resolveVideoFile(kwargs.video);
    const scheduleDate = parseScheduleDate(kwargs.schedule);

    // ── Navigate to the video edit page ──────────────────────────────────────
    await page.goto(EDIT_URL);
    if (!await waitForUrlIncludes(page, 'builder/rc/edit', 60_000)) {
      throw new CommandExecutionError('未能进入百家号视频编辑页（登录态可能失效，请先 opencli baijiahao login）');
    }

    // ── Select the video file ────────────────────────────────────────────────
    if (!await waitForSelector(page, "div[class^='video-main-container'] input, input[type='file']", 30_000)) {
      throw new CommandExecutionError('百家号视频上传输入框未出现');
    }
    await setVideoInput(page, VIDEO_INPUT_SELECTORS, [videoPath]);

    // ── Wait for the publish form ────────────────────────────────────────────
    if (!await waitForSelector(page, 'div#formMain', 60_000)) {
      throw new CommandExecutionError('百家号视频发布表单未出现');
    }
    await page.wait({ time: 1 });

    // ── Title ────────────────────────────────────────────────────────────────
    const finalTitle = await addTitle(page, rawTitle);

    // ── Wait for upload to finish ────────────────────────────────────────────
    if (!await waitUploadingVideo(page)) {
      throw new CommandExecutionError(`百家号视频上传失败: ${videoPath}`);
    }

    // ── Wait for the cover image to render ───────────────────────────────────
    const coverDeadline = Date.now() + 120_000;
    while (Date.now() < coverDeadline) {
      const hasCover = Boolean(unwrap(await page.evaluate(
        `(() => !!document.querySelector('div.cheetah-spin-container img'))()`,
      )));
      if (hasCover) break;
      await page.wait({ time: 3 });
    }

    // ── Publish (scheduled or immediate) ─────────────────────────────────────
    if (scheduleDate) {
      await setSchedulePublish(page, scheduleDate);
    } else {
      await clickByText(page, '发布', { exact: true, timeoutMs: 10_000 });
    }
    await page.wait({ time: 2 });

    // ── Captcha guard ────────────────────────────────────────────────────────
    const captcha = Boolean(unwrap(await page.evaluate(`
      (() => {
        for (const el of document.querySelectorAll('div.passMod_dialog-container')) {
          if (el.offsetParent !== null && (el.innerText || '').includes('百度安全验证')) return true;
        }
        return false;
      })()
    `)));
    if (captcha) throw new CommandExecutionError('百家号出现百度安全验证，请在窗口内手动完成后重试');

    // ── Confirm by landing on builder/rc/clue ────────────────────────────────
    if (!await waitForUrlIncludes(page, 'builder/rc/clue', 8000)) {
      throw new CommandExecutionError('百家号发布未确认成功（未跳转到内容管理页），请检查页面状态');
    }

    return [{
      status: scheduleDate ? '✅ 定时发布已提交' : '✅ 发布成功',
      title: finalTitle,
      url: await currentUrl(page),
    }];
  },
});
