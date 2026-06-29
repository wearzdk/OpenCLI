/**
 * Shared helpers for video-publishing UI adapters (kuaishou / tiktok / youtube /
 * baijiahao). These mirror the primitives the upstream social-auto-upload
 * uploaders rely on (Playwright `set_input_files`, `get_by_text(...).click()`,
 * `wait_for_url`, `locator(text=...).count()`), translated onto opencli's IPage.
 *
 * Kept intentionally small: each adapter owns its own platform-specific flow and
 * selectors; only the truly generic primitives live here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

// Matches upstream uploader/base_video.py SUPPORTED_VIDEO_EXTENSIONS.
export const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.m4v', '.webm', '.flv', '.wmv',
]);
// Matches upstream uploader/base_video.py SUPPORTED_IMAGE_EXTENSIONS.
export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.bmp',
]);

/**
 * Parse a scheduled-publish time (ISO8601 string or Unix seconds/ms) into a
 * Date. Returns null when empty (= publish now). Throws ArgumentError on an
 * unparseable or past time. Shared by all video publish adapters.
 */
export function parseScheduleDate(raw) {
  if (raw == null || raw === '') return null;
  const str = String(raw);
  const dt = /^\d+$/.test(str)
    ? new Date(Number(str) < 1e12 ? Number(str) * 1000 : Number(str))
    : new Date(str);
  if (Number.isNaN(dt.getTime())) throw new ArgumentError(`无法解析定时时间: ${raw}`);
  if (dt.getTime() <= Date.now()) throw new ArgumentError('定时发布时间必须晚于当前时间');
  return dt;
}

/** Some bridge wrappers return `{ data, session }`; unwrap to the raw value. */
export function unwrap(result) {
  if (result && typeof result === 'object' && 'data' in result && 'session' in result) {
    return result.data;
  }
  return result;
}

export async function evalPage(page, script) {
  return unwrap(await page.evaluate(script));
}

export function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Validate a video file path: existence, is-file, supported extension. */
export function resolveVideoFile(filePath) {
  const resolved = path.resolve(String(filePath));
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new ArgumentError(`视频文件不存在: ${resolved}`);
  }
  if (!stat.isFile()) throw new ArgumentError(`视频路径不是文件: ${resolved}`);
  const ext = path.extname(resolved).toLowerCase();
  if (!SUPPORTED_VIDEO_EXTENSIONS.has(ext)) {
    throw new ArgumentError(`不支持的视频格式: ${ext}（支持 ${[...SUPPORTED_VIDEO_EXTENSIONS].join('/')}）`);
  }
  return resolved;
}

/** Validate an image file path: existence, is-file, supported extension. */
export function resolveImageFile(filePath) {
  const resolved = path.resolve(String(filePath));
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new ArgumentError(`图片文件不存在: ${resolved}`);
  }
  if (!stat.isFile()) throw new ArgumentError(`图片路径不是文件: ${resolved}`);
  const ext = path.extname(resolved).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    throw new ArgumentError(`不支持的图片格式: ${ext}（支持 ${[...SUPPORTED_IMAGE_EXTENSIONS].join('/')}）`);
  }
  return resolved;
}

/**
 * Set local files on a file <input>. Prefers CDP DOM.setFileInputFiles (reads
 * the file directly from disk — no size limit, the only sane path for video),
 * trying each candidate selector in turn. The browser bridge must support
 * set-file-input; a video is far too large for the base64 DataTransfer fallback
 * used by image adapters, so we fail loudly if CDP upload is unavailable.
 */
export async function setVideoInput(page, selectors, absPaths) {
  if (!page.setFileInput) {
    throw new CommandExecutionError(
      '浏览器扩展不支持 CDP 文件上传（set-file-input），无法上传视频；请升级 PublishPort 客户端/扩展',
    );
  }
  let lastError;
  for (const sel of selectors) {
    try {
      await page.setFileInput(absPaths, sel);
      return sel;
    } catch (err) {
      lastError = err;
    }
  }
  throw new CommandExecutionError(
    `未找到可用的文件上传输入框（尝试过: ${selectors.join(' , ')}）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** Current page URL (raw location.href), '' on failure. */
export async function currentUrl(page) {
  try {
    if (page.getCurrentUrl) {
      const u = await page.getCurrentUrl();
      if (u) return String(u);
    }
  } catch { /* fall through */ }
  try {
    return String(await evalPage(page, '() => location.href') || '');
  } catch {
    return '';
  }
}

/** Poll until location.href contains `substr` (or any of an array). Returns bool. */
export async function waitForUrlIncludes(page, substr, timeoutMs = 60_000, pollMs = 500) {
  const wants = Array.isArray(substr) ? substr : [substr];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const u = await currentUrl(page);
    if (u && wants.some((w) => u.includes(w))) return true;
    await page.wait({ time: pollMs / 1000 });
  }
  return false;
}

/**
 * Count visible elements whose trimmed innerText contains `text`. Mirrors
 * Playwright `page.locator("text=...").count()` used for upload-status probing.
 */
export async function countByText(page, text) {
  return Number(unwrap(await page.evaluate(`
    ((want) => {
      let n = 0;
      const nodes = document.querySelectorAll('body *');
      for (const el of nodes) {
        if (el.children.length) continue;
        const t = (el.innerText || el.textContent || '').trim();
        if (t && t.includes(want)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) n += 1;
        }
      }
      return n;
    })(${JSON.stringify(text)})
  `))) || 0;
}

/**
 * Click the first visible element whose trimmed text matches `label`. Mirrors
 * Playwright `get_by_text(label).click()` / `:has-text(label)`. With
 * `{ exact: true }` requires an exact text match (`get_by_text(exact=True)`).
 * Returns true if a click was issued.
 */
export async function clickByText(page, label, { exact = false, timeoutMs = 0, pollMs = 500 } = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const ok = Boolean(unwrap(await page.evaluate(`
      ((want, exact) => {
        const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el || el.offsetParent === null) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, label, li, span, div, p'));
        const matches = nodes.filter((n) => {
          if (!isVisible(n)) return false;
          const t = norm(n.innerText || n.textContent);
          return exact ? t === want : (t && t.includes(want));
        });
        // Prefer the innermost match (deepest node) so the real handler fires.
        const innermost = matches.filter((n) => !matches.some((o) => o !== n && n.contains(o)));
        const ordered = innermost.length ? innermost : matches;
        for (const node of ordered) {
          const clickable = node.closest('button, [role="button"], a, label') || node;
          if (clickable.disabled) continue;
          clickable.click();
          return true;
        }
        return false;
      })(${JSON.stringify(label)}, ${exact ? 'true' : 'false'})
    `)));
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await page.wait({ time: pollMs / 1000 });
  }
}

/** True if a visible element with matching text exists (no click). */
export async function existsByText(page, label, { exact = false } = {}) {
  return Boolean(unwrap(await page.evaluate(`
    ((want, exact) => {
      const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
      const isVisible = (el) => {
        if (!el || el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      for (const n of document.querySelectorAll('body *')) {
        if (!isVisible(n)) continue;
        const t = norm(n.innerText || n.textContent);
        if (exact ? t === want : (t && t.includes(want))) return true;
      }
      return false;
    })(${JSON.stringify(label)}, ${exact ? 'true' : 'false'})
  `)));
}

/** Wait for a selector to be present (and visible) in the DOM. Returns bool. */
export async function waitForSelector(page, selector, timeoutMs = 30_000, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = Boolean(unwrap(await page.evaluate(`
      ((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })(${JSON.stringify(selector)})
    `)));
    if (found) return true;
    await page.wait({ time: pollMs / 1000 });
  }
  return false;
}
