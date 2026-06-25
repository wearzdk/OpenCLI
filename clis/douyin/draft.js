/**
 * Douyin draft — upload through the official creator page and save as draft.
 *
 * The previous API pipeline relied on an old pre-upload endpoint that no longer
 * matches creator center's live upload flow. This command now drives the
 * official upload page directly so it stays aligned with the site.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
const VISIBILITY_LABELS = {
    public: '公开',
    friends: '好友可见',
    private: '仅自己可见',
};
const DRAFT_UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload';
const COMPOSER_WAIT_ATTEMPTS = 120;
const COVER_INPUT_WAIT_ATTEMPTS = 20;
const COVER_READY_WAIT_ATTEMPTS = 20;
// The composer's title input + 暂存离开 button surface while the video is still
// uploading/transcoding in the background. The visibility radios and a working
// (enabled) save button settle a beat later than that first paint, and on a slow
// upload that beat can exceed a 10s window — which is what made this command pass
// only intermittently. Give the per-field polls a generous budget so the success
// path no longer depends on upload speed.
const VIDEO_UPLOAD_WAIT_ATTEMPTS = 200; // up to 100s: wait for upload + composer hydration (exits early once ready; well under the 180s+30 ceiling)
/**
 * Best-effort dismissal for coach marks and upload tips that can block clicks.
 */
async function dismissKnownModals(page) {
    await page.evaluate(`() => {
    const targets = ['我知道了', '知道了', '关闭'];
    for (const text of targets) {
      const btn = Array.from(document.querySelectorAll('button,[role="button"]'))
        .find((el) => (el.textContent || '').trim() === text);
      if (btn instanceof HTMLElement) btn.click();
    }
  }`);
}
/**
 * Wait until Douyin finishes uploading and lands on the post-video composer.
 */
async function waitForDraftComposer(page) {
    let lastState = {
        href: '',
        ready: false,
        bodyText: '',
    };
    for (let attempt = 0; attempt < COMPOSER_WAIT_ATTEMPTS; attempt += 1) {
        lastState = (await page.evaluate(`() => ({
      href: location.href,
      ready: !!Array.from(document.querySelectorAll('input')).find(
        (el) => (el.placeholder || '').includes('填写作品标题')
      ) && !!Array.from(document.querySelectorAll('button')).find(
        (el) => (el.textContent || '').includes('暂存离开')
      ),
      bodyText: document.body?.innerText || ''
    })`));
        if (lastState.ready)
            return;
        await page.wait({ time: 0.5 });
    }
    throw new CommandExecutionError('等待抖音草稿编辑页超时', `当前页面: ${lastState.href || 'unknown'}`);
}
/**
 * Wait until the background video upload/transcode finishes AND the composer is
 * fully hydrated and ready to fill.
 *
 * Root cause of this command's intermittence: `waitForDraftComposer` returns as
 * soon as the title input + 暂存离开 button first paint, but the rest of the
 * composer (the caption contenteditable editor, the visibility radios) only
 * hydrates *after* the video upload/transcode completes — which on a normal
 * connection routinely takes longer than the per-field poll windows. That is why
 * `caption-editor-missing` / `visibility-missing` appeared at random.
 *
 * The reliable readiness signal is the composer's own fields, not a progress
 * string: wait until the caption editor exists, the requested visibility label
 * exists, the 暂存离开 button is enabled, and no upload-in-progress copy remains.
 * Gating fills on this makes the downstream steps deterministic instead of
 * racing the upload. Combined with the raised `--timeout` ceiling (default 180s),
 * this comfortably covers slow uploads.
 *
 * Best-effort: never throws — if a clear signal can't be read within the budget
 * we fall through and let the (bounded, patient) field polls remain the safety
 * net, so behavior is never worse than before.
 */
async function waitForVideoUploadComplete(page, visibilityLabel) {
    for (let attempt = 0; attempt < VIDEO_UPLOAD_WAIT_ATTEMPTS; attempt += 1) {
        const state = (await page.evaluate(`() => {
      const text = document.body?.innerText || '';
      const uploading = /上传中|上传\\s*\\d+%|视频上传中|处理中/.test(text);
      const saveBtn = Array.from(document.querySelectorAll('button')).find(
        (el) => (el.textContent || '').includes('暂存离开')
      );
      const saveEnabled = saveBtn instanceof HTMLButtonElement
        ? !saveBtn.disabled && saveBtn.getAttribute('aria-disabled') !== 'true'
        : false;
      const hasCaptionEditor = !!document.querySelector('[contenteditable="true"]');
      const hasVisibility = !!Array.from(document.querySelectorAll('label')).find(
        (el) => (el.textContent || '').includes(${JSON.stringify(visibilityLabel)})
      );
      return { uploading, saveEnabled, hasSaveBtn: !!saveBtn, hasCaptionEditor, hasVisibility };
    }`));
        // Ready once the composer's real fields exist, the save button is usable,
        // and no upload-in-progress copy remains.
        if (state.hasSaveBtn
            && state.saveEnabled
            && state.hasCaptionEditor
            && state.hasVisibility
            && !state.uploading) {
            return;
        }
        await page.wait({ time: 0.5 });
    }
    // Fall through silently; downstream bounded polls remain the safety net.
}
/**
 * Fill title, caption and visibility controls on the live composer page.
 */
async function fillDraftComposer(page, options) {
    // The composer hydrates its sub-fields (title input, caption editor,
    // visibility labels) progressively after `waitForDraftComposer` returns, so a
    // one-shot probe of each can race the render and false-fail. Poll each field a
    // bounded number of times before giving up — same evaluate script, only more
    // patient. Raised from 20 (10s) to 60 (30s): on a slow upload the visibility
    // radios can settle well after the title input, and a 10s window made this
    // step fail intermittently.
    const FILL_FIELD_ATTEMPTS = 60;
    let titleOk = false;
    for (let attempt = 0; attempt < FILL_FIELD_ATTEMPTS; attempt += 1) {
        titleOk = (await page.evaluate(`() => {
    const titleInput = Array.from(document.querySelectorAll('input')).find(
      (el) => (el.placeholder || '').includes('填写作品标题')
    );
    if (!(titleInput instanceof HTMLInputElement)) return false;
    const propKey = Object.keys(titleInput).find((key) => key.startsWith('__reactProps$'));
    const props = propKey ? titleInput[propKey] : null;
    if (props?.onChange) {
      props.onChange({
        target: { value: ${JSON.stringify(options.title)} },
        currentTarget: { value: ${JSON.stringify(options.title)} },
      });
    } else {
      titleInput.focus();
      titleInput.value = ${JSON.stringify(options.title)};
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      titleInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (props?.onBlur) {
      props.onBlur({
        target: titleInput,
        currentTarget: titleInput,
        relatedTarget: null,
      });
    } else {
      titleInput.dispatchEvent(new Event('blur', { bubbles: true }));
    }
    return true;
  }`));
        if (titleOk)
            break;
        await page.wait({ time: 0.5 });
    }
    if (!titleOk) {
        throw new CommandExecutionError('填写抖音草稿表单失败: title-input-missing');
    }
    if (options.caption) {
        let captionOk = false;
        for (let attempt = 0; attempt < FILL_FIELD_ATTEMPTS; attempt += 1) {
            captionOk = (await page.evaluate(`() => {
      const editor = document.querySelector('[contenteditable="true"]');
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      editor.textContent = '';
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, ${JSON.stringify(options.caption)});
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }`));
            if (captionOk)
                break;
            await page.wait({ time: 0.5 });
        }
        if (!captionOk) {
            throw new CommandExecutionError('填写抖音草稿表单失败: caption-editor-missing');
        }
    }
    let visibilityOk = false;
    for (let attempt = 0; attempt < FILL_FIELD_ATTEMPTS; attempt += 1) {
        visibilityOk = (await page.evaluate(`() => {
    const visibility = Array.from(document.querySelectorAll('label')).find(
      (el) => (el.textContent || '').includes(${JSON.stringify(options.visibilityLabel)})
    );
    if (!(visibility instanceof HTMLElement)) return false;
    visibility.click();
    return true;
  }`));
        if (visibilityOk)
            break;
        await page.wait({ time: 0.5 });
    }
    if (!visibilityOk) {
        throw new CommandExecutionError('填写抖音草稿表单失败: visibility-missing');
    }
}
/**
 * Switch the composer into custom-cover mode and expose the cover input with a
 * stable selector for CDP file injection.
 */
async function prepareCustomCoverInput(page) {
    let lastReason = 'cover-input-missing';
    const baselineCount = (await page.evaluate(`() => Array.from(document.querySelectorAll('input[type="file"]')).length`));
    for (let attempt = 0; attempt < COVER_INPUT_WAIT_ATTEMPTS; attempt += 1) {
        const result = (await page.evaluate(`() => {
      const coverLabel = Array.from(document.querySelectorAll('label')).find(
        (el) => (el.textContent || '').includes('上传新封面')
      );
      if (coverLabel instanceof HTMLElement) {
        coverLabel.click();
      }

      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const target = inputs
        .slice(${JSON.stringify(baselineCount)})
        .find((el) => el instanceof HTMLInputElement && !el.disabled);
      if (!(target instanceof HTMLInputElement)) {
        return { ok: false, reason: 'cover-input-pending' };
      }

      document
        .querySelectorAll('[data-opencli-cover-input="1"]')
        .forEach((el) => el.removeAttribute('data-opencli-cover-input'));
      target.setAttribute('data-opencli-cover-input', '1');
      return { ok: true, selector: '[data-opencli-cover-input="1"]' };
    }`));
        if (result?.ok && result.selector) {
            return result.selector;
        }
        lastReason = result?.reason || lastReason;
        await page.wait({ time: 0.5 });
    }
    throw new CommandExecutionError(`准备抖音自定义封面输入框失败: ${lastReason}`);
}
/**
 * Read the local quick-check panel text that reflects cover validation state.
 */
export function buildCoverCheckPanelTextJs() {
    return `() => {
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const stateTexts = ['检测', '检测中', '封面检测中', '重新检测', '横/竖双封面缺失'];
    const marker = Array.from(document.querySelectorAll('div,span,p,button')).find(
      (el) => normalize(el.textContent) === '快速检测'
    );
    let root = marker?.parentElement || null;
    while (root && root !== document.body) {
      const descendants = Array.from(root.querySelectorAll('div,span,p,button'))
        .map((el) => normalize(el.textContent));
      const hasMarkerText = descendants.includes('快速检测');
      const hasStateText = descendants.some((text) => stateTexts.includes(text));
      if (hasMarkerText && hasStateText) {
        return normalize(root.textContent).slice(0, 400);
      }
      root = root.parentElement;
    }
    return '';
  }`;
}
async function getCoverCheckPanelText(page) {
    return (await page.evaluate(buildCoverCheckPanelTextJs())) || '';
}
/**
 * Wait for Douyin's cover-detection pipeline to expose a post-upload signal.
 * In the live creator page, custom cover upload first shows `封面检测中`, then
 * lands on a ready state such as `重新检测` or the warning copy for missing
 * horizontal/vertical covers.
 */
async function waitForCoverReady(page) {
    let lastPanelText = '';
    let sawBusy = false;
    for (let attempt = 0; attempt < COVER_READY_WAIT_ATTEMPTS; attempt += 1) {
        const panelText = await getCoverCheckPanelText(page);
        const busy = panelText.includes('检测中');
        const ready = (panelText.includes('重新检测')
            || panelText.includes('横/竖双封面缺失'));
        if (busy) {
            sawBusy = true;
        }
        if (sawBusy && ready && !busy) {
            return;
        }
        lastPanelText = panelText;
        await page.wait({ time: 0.5 });
    }
    throw new CommandExecutionError('等待抖音封面处理完成超时', lastPanelText || 'unknown');
}
/**
 * Click the draft button on the composer page and extract the current creation id.
 */
async function clickSaveDraft(page) {
    // The 暂存离开 button and the React fiber carrying `creation_id` can both
    // settle a beat after the form is filled. A one-shot probe races that and
    // false-fails with draft-button-missing / creation-id-missing. Poll a bounded
    // number of times — same evaluate script — before giving up. Retrying only
    // happens while the button is absent OR still disabled (ok===false), so the
    // click never fires more than once and never fires on a disabled button.
    // Raised from 20 (10s) to 60 (30s) to absorb slow uploads.
    const SAVE_DRAFT_ATTEMPTS = 60;
    let result = null;
    for (let attempt = 0; attempt < SAVE_DRAFT_ATTEMPTS; attempt += 1) {
        result = (await page.evaluate(`() => {
    const extractCreationId = () => {
      const titleInput = Array.from(document.querySelectorAll('input')).find(
        (el) => (el.placeholder || '').includes('填写作品标题')
      );
      if (!(titleInput instanceof HTMLInputElement)) return '';

      const fiberKey = Object.keys(titleInput).find((key) => key.startsWith('__reactFiber$'));
      let fiber = fiberKey ? titleInput[fiberKey] : null;
      while (fiber) {
        const props = fiber.memoizedProps;
        if (typeof props?.creation_id === 'string' && props.creation_id) {
          return props.creation_id;
        }
        fiber = fiber.return;
      }
      return '';
    };

    const btn = Array.from(document.querySelectorAll('button')).find(
      (el) => (el.textContent || '').includes('暂存离开')
    );
    if (!(btn instanceof HTMLButtonElement)) {
      return { ok: false, reason: 'draft-button-missing' };
    }
    // The button paints before the upload finishes and is disabled until then.
    // Treat a disabled button as "not ready yet" so the poll keeps waiting
    // instead of firing a no-op click and then failing on a missing creation_id.
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      return { ok: false, reason: 'draft-button-disabled' };
    }
    const creationId = extractCreationId();
    const propKey = Object.keys(btn).find((key) => key.startsWith('__reactProps$'));
    const props = propKey ? btn[propKey] : null;
    if (props?.onClick) {
      props.onClick({
        preventDefault() {},
        stopPropagation() {},
        nativeEvent: null,
        target: btn,
        currentTarget: btn,
      });
    } else {
      btn.click();
    }
    return {
      ok: true,
      text: (btn.textContent || '').trim(),
      creationId,
    };
  }`));
        if (result?.ok)
            break;
        await page.wait({ time: 0.5 });
    }
    if (!result?.ok) {
        throw new CommandExecutionError(`点击草稿按钮失败: ${result?.reason || 'unknown'}`);
    }
    if (!result.creationId) {
        throw new CommandExecutionError('点击草稿按钮失败: creation-id-missing');
    }
    return {
        text: result.text || '暂存离开',
        creationId: result.creationId,
    };
}
/**
 * Wait until creator center confirms the draft was saved.
 *
 * After clicking 暂存离开 Douyin can land on several equivalent success states
 * depending on timing and A/B layout: the upload page may show the resumable
 * `继续编辑` prompt, a `草稿保存成功` toast may flash, or the page may navigate
 * to the content-manage / draft list. Requiring only the first (`继续编辑` on the
 * upload URL) within a tight 20s window false-failed when any other equivalent
 * state was reached first. We already hold a real `creation_id` extracted from
 * the live React fiber at click time, so the save was issued — this step only
 * confirms it landed. Accept any of the success signals and poll longer (40s).
 */
async function waitForDraftResult(page, creationId) {
    let lastState = { href: '', bodyText: '' };
    for (let attempt = 0; attempt < 40; attempt += 1) {
        lastState = (await page.evaluate(`() => ({
      href: location.href,
      bodyText: document.body?.innerText || ''
    })`));
        const href = lastState.href || '';
        const body = lastState.bodyText || '';
        const resumablePrompt = href.includes('/creator-micro/content/upload')
            && /继续编辑/.test(body);
        const saveToast = /草稿保存成功|已保存到草稿|存草稿成功|保存成功/.test(body);
        // Navigated away from the composer to the content-manage / draft area.
        const navigatedToManage = /\/creator-micro\/content\/(manage|drafts|works)/.test(href)
            || (/创作中心/.test(body) && !href.includes('/content/upload'));
        if (resumablePrompt || saveToast || navigatedToManage) {
            return creationId;
        }
        await page.wait({ time: 1 });
    }
    throw new CommandExecutionError('未检测到抖音草稿保存确认', `当前页面: ${lastState.href || 'unknown'}`);
}
cli({
    site: 'douyin',
    name: 'draft',
    access: 'write',
    description: '上传视频并保存为草稿',
    domain: 'creator.douyin.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
        { name: 'video', required: true, positional: true, help: '视频文件路径' },
        { name: 'title', required: true, help: '视频标题（≤30字）' },
        { name: 'caption', default: '', help: '正文内容（≤1000字，支持 #话题）' },
        { name: 'cover', default: '', help: '封面图片路径' },
        { name: 'visibility', default: 'public', choices: ['public', 'friends', 'private'] },
        // Video upload + transcode + composer hydration + form fill + save can
        // easily exceed the global 60s browser-command ceiling on a normal
        // connection, which made this command time out intermittently. Declaring
        // a `timeout` arg opts this command into runtime-enforced timeouts and
        // raises its default ceiling to 180s; callers can pass --timeout <secs>
        // for larger videos. (See execution.js readUserTimeoutSeconds: a declared
        // `timeout` arg's default becomes the ceiling.)
        { name: 'timeout', type: 'int', default: 180, help: '命令超时（秒），视频上传/转码慢时可调大' },
    ],
    columns: ['status', 'draft_id'],
    func: async (page, kwargs) => {
        const videoPath = path.resolve(kwargs.video);
        if (!fs.existsSync(videoPath)) {
            throw new ArgumentError(`视频文件不存在: ${videoPath}`);
        }
        const ext = path.extname(videoPath).toLowerCase();
        if (!['.mp4', '.mov', '.avi', '.webm'].includes(ext)) {
            throw new ArgumentError(`不支持的视频格式: ${ext}（支持 mp4/mov/avi/webm）`);
        }
        const title = kwargs.title;
        if (title.length > 30) {
            throw new ArgumentError('标题不能超过 30 字');
        }
        const caption = kwargs.caption || '';
        if (caption.length > 1000) {
            throw new ArgumentError('正文不能超过 1000 字');
        }
        const coverPath = kwargs.cover;
        if (coverPath) {
            if (!fs.existsSync(path.resolve(coverPath))) {
                throw new ArgumentError(`封面文件不存在: ${path.resolve(coverPath)}`);
            }
        }
        if (!page.setFileInput) {
            throw new CommandExecutionError('当前浏览器适配器不支持文件注入', '请使用 Browser Bridge 或支持 setFileInput 的浏览器模式');
        }
        const visibilityLabel = VISIBILITY_LABELS[kwargs.visibility] ?? VISIBILITY_LABELS.public;
        await page.goto(DRAFT_UPLOAD_URL);
        await page.wait({ selector: 'input[type="file"]', timeout: 20 });
        await dismissKnownModals(page);
        await page.setFileInput([videoPath], 'input[type="file"]');
        await waitForDraftComposer(page);
        await waitForVideoUploadComplete(page, visibilityLabel);
        await dismissKnownModals(page);
        if (coverPath) {
            const coverSelector = await prepareCustomCoverInput(page);
            await page.setFileInput([path.resolve(coverPath)], coverSelector);
            await waitForCoverReady(page);
        }
        await fillDraftComposer(page, { title, caption, visibilityLabel });
        await page.wait({ time: 1 });
        const saveResult = await clickSaveDraft(page);
        const draftId = await waitForDraftResult(page, saveResult.creationId);
        return [
            {
                status: '✅ 草稿已保存，可在创作中心继续编辑',
                draft_id: draftId,
            },
        ];
    },
});
