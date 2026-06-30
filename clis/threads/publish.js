import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { threadsAuth, threadsGet, threadsPost } from './auth.js';

// Threads 发布。Meta 官方两步流程：① 建容器（/{user-id}/threads，media_type=TEXT/IMAGE/VIDEO/
// CAROUSEL）→ 拿 creation_id；② 发布（/{user-id}/threads_publish，creation_id）。
// 原子能力：纯文本 / 单图 / 单视频 / 多图轮播(carousel)、alt 文本、link_attachment、回复。

function splitCsv(raw) {
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

cli({
  site: 'threads',
  name: 'post',
  access: 'write',
  description: 'Publish a Threads post (text / single image / video / image carousel). Two-step container → publish.',
  domain: 'threads.net',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'text', type: 'string', required: false, help: 'Post text (required for TEXT; optional caption otherwise)' },
    { name: 'image-url', type: 'string', required: false, help: 'Single public image URL (IMAGE post)' },
    { name: 'video-url', type: 'string', required: false, help: 'Single public video URL (VIDEO post)' },
    { name: 'images', type: 'string', required: false, help: 'Comma-separated image URLs for a carousel (2-20)' },
    { name: 'alt-text', type: 'string', required: false, help: 'Accessibility alt text (single media)' },
    { name: 'link-attachment', type: 'string', required: false, help: 'Link attachment URL (TEXT posts only)' },
    { name: 'reply-to-id', type: 'string', required: false, help: 'Reply to an existing Threads media id' },
  ],
  columns: ['status', 'id', 'creation_id', 'permalink'],
  func: async (kwargs) => {
    const { token, userId } = await threadsAuth();
    const text = kwargs.text !== undefined ? String(kwargs.text) : undefined;
    const carousel = kwargs.images ? splitCsv(kwargs.images) : [];

    let creationId;

    if (carousel.length) {
      if (carousel.length < 2 || carousel.length > 20) {
        throw new ArgumentError(`Carousel needs 2-20 images (got ${carousel.length})`);
      }
      // 每张图建子容器（is_carousel_item=true）→ 收集 id → 建 CAROUSEL 容器。
      const childIds = [];
      for (const imageUrl of carousel) {
        const child = await threadsPost(token, `${userId}/threads`, { media_type: 'IMAGE', image_url: imageUrl, is_carousel_item: 'true' });
        if (!child?.id) throw new CommandExecutionError(`Threads carousel item container failed for ${imageUrl}`);
        childIds.push(child.id);
      }
      const container = await threadsPost(token, `${userId}/threads`, {
        media_type: 'CAROUSEL', children: childIds.join(','), text,
      });
      creationId = container?.id;
    } else {
      const params = { reply_to_id: kwargs['reply-to-id'] };
      if (kwargs['image-url']) {
        Object.assign(params, { media_type: 'IMAGE', image_url: String(kwargs['image-url']), alt_text: kwargs['alt-text'], text });
      } else if (kwargs['video-url']) {
        Object.assign(params, { media_type: 'VIDEO', video_url: String(kwargs['video-url']), alt_text: kwargs['alt-text'], text });
      } else {
        if (!text) throw new ArgumentError('Provide --text (or media via --image-url / --video-url / --images)');
        Object.assign(params, { media_type: 'TEXT', text, link_attachment: kwargs['link-attachment'] });
      }
      const container = await threadsPost(token, `${userId}/threads`, params);
      creationId = container?.id;
    }

    if (!creationId) throw new CommandExecutionError('Threads container creation returned no id');

    // ② 发布。
    const published = await threadsPost(token, `${userId}/threads_publish`, { creation_id: creationId });
    const mediaId = published?.id;
    if (!mediaId) throw new CommandExecutionError('Threads publish returned no media id');

    // 回查 permalink（best-effort，失败不影响发布成功）。
    let permalink = '';
    try {
      const meta = await threadsGet(token, mediaId, 'permalink');
      permalink = meta?.permalink ?? '';
    } catch { /* permalink 可选 */ }

    return [{ status: 'success', id: mediaId, creation_id: creationId, permalink }];
  },
});
