/**
 * YouTube video publish — YouTube Studio (browser automation, no Data API).
 *
 * Faithfully ported from upstream social-auto-upload youtube_uploader
 * (YouTubeVideo.upload). Browser automation is used deliberately (an unaudited
 * Data API locks videos to private); this matches the cookie-based pattern of
 * every other uploader.
 *
 *   1. open youtube.com/upload, pick the video file
 *   2. fill title + (optional) description, (optional) thumbnail / playlist
 *   3. audience = not made for kids; (optional) tags
 *   4. Next ×N → visibility; wait for upload to finish; publish (#done-button)
 *
 * One command does the whole flow. Requires being logged into youtube.com.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import {
  resolveVideoFile, resolveImageFile, setVideoInput, unwrap, currentUrl, waitForSelector,
} from '../_shared/video-publish.js';

const UPLOAD_URL = 'https://www.youtube.com/upload';
const VISIBILITY = { public: 'PUBLIC', unlisted: 'UNLISTED', private: 'PRIVATE' };

// In-page helper: resolve a comma-separated selector list that may contain
// `:has-text('...')` clauses (YouTube Polymer components), return the first
// VISIBLE matching element. Used for click / wait.
const RESOLVE_FN = `
  function __ytNorm(v) { return (v || '').replace(/\\s+/g, ' ').trim(); }
  function __ytVisible(el) {
    if (!el || el.offsetParent === null) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function __ytResolve(selectorList) {
    var parts = selectorList.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var m = part.match(/^(.*?):has-text\\((['"])(.*?)\\2\\)$/);
      if (m) {
        var base = m[1] || '*';
        var want = m[3];
        var nodes = document.querySelectorAll(base);
        for (var j = 0; j < nodes.length; j++) {
          if (__ytVisible(nodes[j]) && __ytNorm(nodes[j].innerText || nodes[j].textContent).indexOf(want) >= 0) {
            return nodes[j];
          }
        }
      } else {
        var el = null;
        try { el = document.querySelector(part); } catch (e) { el = null; }
        if (el && __ytVisible(el)) return el;
      }
    }
    return null;
  }
`;

async function clickIfPresent(page, selectorList, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const clicked = Boolean(unwrap(await page.evaluate(`
      (() => {
        ${RESOLVE_FN}
        var el = __ytResolve(${JSON.stringify(selectorList)});
        if (!el) return false;
        el.click();
        return true;
      })()
    `)));
    if (clicked) return true;
    if (Date.now() >= deadline) return false;
    await page.wait({ time: 0.4 });
  }
}

async function isPresentVisible(page, selectorList) {
  return Boolean(unwrap(await page.evaluate(`
    (() => { ${RESOLVE_FN} return !!__ytResolve(${JSON.stringify(selectorList)}); })()
  `)));
}

async function dismissAutocomplete(page) {
  // blur the active element (closes the # topic / @ mention dropdown)
  try { await page.evaluate('() => { const a = document.activeElement; if (a && a.blur) a.blur(); }'); } catch { /* noop */ }
  try {
    const open = Boolean(unwrap(await page.evaluate(`
      (() => { ${RESOLVE_FN} return !!__ytResolve('tp-yt-iron-dropdown'); })()
    `)));
    if (open) { await page.pressKey('Escape'); await page.wait({ time: 0.2 }); }
  } catch { /* noop */ }
}

// Fill a Studio contenteditable (#textbox). Clear then insert in one shot —
// per-char typing would trigger the # topic autocomplete overlay and jam the flow.
async function fillEditable(page, selector, text) {
  if (!await waitForSelector(page, selector, 30_000)) {
    throw new CommandExecutionError(`YouTube 输入框未出现: ${selector}`);
  }
  await page.click(selector);
  await page.pressKey('Control+a');
  await page.pressKey('Delete');
  await page.insertText(text);
  await page.wait({ time: 0.4 });
  await dismissAutocomplete(page);
}

// Wait until the in-page upload reaches a processing/finished state (closing
// the browser mid-upload truncates it). Matches upstream _wait_upload_complete.
async function waitUploadComplete(page, maxPolls = 360) {
  const DONE_RE = /处理|检查|上传完成|已上传|Processing|complete|Checks|Finished/;
  for (let i = 0; i < maxPolls; i++) {
    const txt = String(unwrap(await page.evaluate(`
      (() => {
        const sels = ['.progress-label', 'span.progress-label', 'ytcp-video-upload-progress'];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el) { const t = (el.innerText || '').trim(); if (t) return t; }
        }
        return '';
      })()
    `)) || '');
    if (txt && DONE_RE.test(txt)) return true;
    await page.wait({ time: 5 });
  }
  return false; // upstream still attempts to publish after timeout
}

cli({
  site: 'youtube',
  name: 'publish',
  access: 'write',
  description: 'Publish a video to YouTube via Studio (one command: upload + metadata + publish)',
  domain: 'www.youtube.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'video', required: true, positional: true, help: 'Video file path' },
    { name: 'title', required: true, help: 'Video title (≤100 chars)' },
    { name: 'description', default: '', help: 'Video description' },
    { name: 'tags', default: '', help: 'Comma-separated tags' },
    { name: 'thumbnail', default: '', help: 'Thumbnail image path (optional)' },
    { name: 'playlist', default: '', help: 'Playlist name to add to (optional)' },
    { name: 'visibility', default: 'public', choices: ['public', 'unlisted', 'private'], help: 'Visibility' },
  ],
  columns: ['status', 'title', 'visibility', 'url'],
  func: async (page, kwargs) => {
    const title = String(kwargs.title ?? '').trim();
    if (!title) throw new ArgumentError('--title is required');
    const videoPath = resolveVideoFile(kwargs.video);
    const description = String(kwargs.description || '');
    const thumbnailPath = kwargs.thumbnail ? resolveImageFile(kwargs.thumbnail) : '';
    const playlist = String(kwargs.playlist || '').trim();
    const visibility = VISIBILITY[kwargs.visibility] ? kwargs.visibility : 'public';

    // ── Navigate ─────────────────────────────────────────────────────────────
    await page.goto(UPLOAD_URL);
    await page.wait({ time: 3 });
    const url0 = await currentUrl(page);
    if (/accounts\.google\.com/.test(url0) || /signin/i.test(url0)) {
      throw new CommandExecutionError('YouTube 登录态失效，请先 opencli youtube login');
    }

    // ── 1) Select the video file ─────────────────────────────────────────────
    if (!await waitForSelector(page, 'input[type="file"]', 60_000)) {
      throw new CommandExecutionError('YouTube 上传文件输入框未出现');
    }
    await setVideoInput(page, ['input[type="file"]'], [videoPath]);

    // ── 2) Wait for details dialog, fill title ───────────────────────────────
    if (!await waitForSelector(page, '#title-textarea', 120_000)) {
      throw new CommandExecutionError('YouTube 视频详情对话框未出现');
    }
    await fillEditable(page, '#title-textarea #textbox', title.slice(0, 100));

    // ── 3) Description ───────────────────────────────────────────────────────
    if (description.trim()) {
      await fillEditable(page, '#description-textarea #textbox', description);
    }

    // ── 4) Thumbnail (non-fatal) ─────────────────────────────────────────────
    if (thumbnailPath) {
      try {
        await setVideoInput(page,
          ["#file-loader input[type='file']", "ytcp-thumbnail-uploader input[type='file']"],
          [thumbnailPath]);
        await page.wait({ time: 2 });
      } catch { /* thumbnail is optional */ }
    }

    // ── 5) Playlist (optional, non-fatal) ────────────────────────────────────
    if (playlist) {
      try {
        await clickIfPresent(page, '#basics ytcp-text-dropdown-trigger, ytcp-video-metadata-playlists ytcp-dropdown-trigger', 8000);
        await page.wait({ time: 1.2 });
        const existing = `tp-yt-paper-checkbox:has-text('${playlist}'), ytcp-checkbox-group:has-text('${playlist}')`;
        if (await isPresentVisible(page, existing)) {
          await clickIfPresent(page, existing, 3000);
        } else if (await clickIfPresent(page, "ytcp-button:has-text('New playlist'), ytcp-button:has-text('创建播放列表')", 4000)) {
          await page.wait({ time: 0.8 });
          await clickIfPresent(page, "tp-yt-paper-item:has-text('New playlist'), tp-yt-paper-item:has-text('新建播放列表')", 3000);
          const titleBox = 'ytcp-playlist-metadata-editor #textbox, #create-playlist-form #textbox';
          if (await waitForSelector(page, titleBox.split(',')[0].trim(), 4000) || await isPresentVisible(page, titleBox)) {
            await clickIfPresent(page, titleBox, 2000);
            await page.insertText(playlist);
            await clickIfPresent(page, "ytcp-button#create-button, tp-yt-paper-dialog ytcp-button:has-text('Create'), tp-yt-paper-dialog ytcp-button:has-text('创建')", 4000);
          }
        }
      } catch { /* playlist is optional */ }
      finally {
        await clickIfPresent(page, "ytcp-playlist-dialog #save-button, ytcp-button:has-text('Done'), ytcp-button:has-text('完成')", 3000);
        await page.pressKey('Escape');
        await page.wait({ time: 0.6 });
      }
    }

    // ── 6) Audience: not made for kids (required) ────────────────────────────
    if (!await clickIfPresent(page, "tp-yt-paper-radio-button[name='VIDEO_MADE_FOR_KIDS_NOT_MFK']", 10_000)) {
      await clickIfPresent(page, "tp-yt-paper-radio-button:has-text('not made for kids'), tp-yt-paper-radio-button:has-text('不是面向儿童')", 6000);
    }

    // ── 7) Tags (under "Show more") ──────────────────────────────────────────
    if (kwargs.tags) {
      const tagsCsv = String(kwargs.tags).split(',').map((s) => s.trim()).filter(Boolean).join(',');
      try {
        await clickIfPresent(page, '#toggle-button', 6000);
        await page.wait({ time: 0.8 });
        const tagInput = "#tags-container #text-input, ytcp-form-input-container#tags-container input";
        if (await isPresentVisible(page, tagInput)) {
          await clickIfPresent(page, tagInput, 3000);
          await page.insertText(`${tagsCsv.slice(0, 500)},`);
        }
      } catch { /* tags optional */ }
    }

    // ── 8) Next ×N until the visibility step (PUBLIC radio) appears ──────────
    for (let i = 0; i < 5; i++) {
      if (await isPresentVisible(page, "tp-yt-paper-radio-button[name='PUBLIC']")) break;
      if (!await clickIfPresent(page, '#next-button', 6000)) await page.wait({ time: 1.2 });
      await page.wait({ time: 1 });
    }

    // ── 9) Visibility ────────────────────────────────────────────────────────
    await clickIfPresent(page, `tp-yt-paper-radio-button[name='${VISIBILITY[visibility]}']`, 10_000);

    // ── 10) Wait for the upload to truly finish before publishing ────────────
    await waitUploadComplete(page);

    // ── 11) Publish ──────────────────────────────────────────────────────────
    await page.wait({ time: 1.2 });
    let videoUrl = '';
    if (!await clickIfPresent(page, '#done-button', 15_000)) {
      throw new CommandExecutionError('未找到 YouTube 发布按钮（上传可能未到可发布进度），请在窗口内手动发布');
    }
    await page.wait({ time: 4 });
    videoUrl = String(unwrap(await page.evaluate(`
      (() => {
        const a = document.querySelector("a[href*='youtu.be'], a[href*='watch?v=']");
        return a ? (a.getAttribute('href') || '') : '';
      })()
    `)) || '');
    await clickIfPresent(page, "ytcp-button:has-text('Close'), ytcp-button:has-text('关闭'), #close-button", 8000);

    return [{
      status: '✅ Published',
      title,
      visibility,
      url: videoUrl,
    }];
  },
});
