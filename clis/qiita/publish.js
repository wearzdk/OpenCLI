import * as fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { qiitaGql, qiitaDeleteByForm } from './gql.js';

// Qiita 投稿の発行 —— [pp-only] 复用浏览器登录态，打 web 编辑器自家的 `POST /graphql`：
//   1. saveCreatingArticle   —— 先落草稿（拿服务端分配的 uuid，作幂等锚点）
//   2. publishPublicArticle  —— 公开发布（或 publishSecretArticle 限定公开）
// 不走官方 /api/v2/items：那条 REST 只认 Bearer PAT，浏览器会话 cookie 命中 401（已真机坐实），
// 用不了登录态。草稿/公开/限定公开靠「调哪个 mutation」区分，不是一个 private 布尔（Qiita web 的真实模型）。
//
// uuid 的真相（照搬 Qiita 自家 v3 编辑器 bundle 的逻辑，cdn.qiita.com/assets/public/v3-editor-bundle-*.min.js）：
//   - `/drafts/new` 的引导数据里 CreatingArticle 的 `uuid` 是空串 ""，服务端此刻并未建记录；
//   - 编辑器首次 `saveCreatingArticle` 时传 `uuid:""`，服务端创建记录并在 `draftItem.uuid` 回真实 uuid，
//     随后 history.replaceState 到 `/drafts/<uuid>/edit`。
//   - `saveCreatingArticle` 是「按 uuid 更新」，对不存在的 uuid 报 RecordNotFound——所以绝不能自己生成 uuid 直接发。
//   据此：首发一律传 `uuid:''` 让服务端建并回 uuid，再用该 uuid 走 publish。
//   （历史 bug：旧实现自造 20 位 hex uuid 直接 save，必 RecordNotFound。）
//
// 注：本命令专注「新建并发布/存草稿」（发布主用例），不做按已有 item-id 的更新。

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

// Qiita タグ：web GraphQL は文字列配列（`["Python","Flask"]`）。少なくとも 1 つ必要。
export function resolveTagNames(raw) {
  return String(raw ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

// GraphQL 文档与字段照搬 Qiita 自家 v3 编辑器 bundle 里实际发出的 mutation：
//   - SaveCreatingArticleInput：{ uuid, title, rawBody, tagNames, slide, organizationId? }
//   - PublishPublicArticleInput：{ uuid, title, rawBody, tagNames, slide, tweetShare, adventCalendarItems }
//       —— tweetShare / adventCalendarItems 服务端校验为非空（真机实测缺它们报 "Expected value to not be null"）。
//   - PublishSecretArticleInput：{ uuid, title, rawBody, tagNames, slide }（限定公开不能推文，无 tweetShare）。
// 返回选择集照搬编辑器：article { encryptedId isSecret linkUrl uuid }。
const SAVE_DRAFT = `mutation($input: SaveCreatingArticleInput!) {
  saveCreatingArticle(input: $input) { draftItem { uuid } }
}`;
const PUBLISH_PUBLIC = `mutation($input: PublishPublicArticleInput!) {
  publishPublicArticle(input: $input) { article { uuid linkUrl encryptedId isSecret } }
}`;
const PUBLISH_SECRET = `mutation($input: PublishSecretArticleInput!) {
  publishSecretArticle(input: $input) { article { uuid linkUrl encryptedId isSecret } }
}`;

cli({
  site: 'qiita',
  name: 'publish',
  access: 'write',
  description: 'Publish a Qiita article (markdown). Tags required. Public by default; --draft or --secret to change.',
  domain: 'qiita.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'title', type: 'string', required: false, help: 'Article title (required)' },
    { name: 'body', type: 'string', required: false, help: 'Article body in Markdown (or use --body-file)' },
    { name: 'body-file', type: 'string', required: false, help: 'Path to a Markdown file for the body' },
    { name: 'tags', type: 'string', required: false, help: 'Comma-separated tags (REQUIRED, at least 1)' },
    { name: 'draft', type: 'boolean', required: false, default: false, help: 'Save as draft only (do not publish)' },
    { name: 'secret', type: 'boolean', required: false, default: false, help: 'Publish as limited-public (secret) instead of public' },
    { name: 'tweet-share', type: 'boolean', required: false, default: false, help: 'Also share to X/Twitter on publish (public only)' },
  ],
  columns: ['status', 'uuid', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for qiita publish');
    const title = String(kwargs.title ?? '').trim();
    const body = resolveBody(kwargs);
    const tagNames = resolveTagNames(kwargs.tags);

    if (!title) throw new ArgumentError('--title is required');
    if (body === undefined) throw new ArgumentError('--body or --body-file is required');
    if (tagNames.length === 0) throw new ArgumentError('--tags is required (Qiita articles need at least one tag)');

    // 0) 进编辑器页拿同源上下文（csrf meta + 登录 cookie）。在 `/drafts/new` 上发起请求，与编辑器同源。
    await page.goto('https://qiita.com/drafts/new');
    await page.wait({ time: 2 });

    // 1) 首次保存传空 uuid → 服务端创建 CreatingArticle 记录并回真实 uuid（绝不能自己生成 uuid）。
    const draftData = await qiitaGql(page, SAVE_DRAFT, {
      input: { uuid: '', title, rawBody: body, tagNames, slide: false, organizationId: null },
    });
    const draftUuid = draftData?.saveCreatingArticle?.draftItem?.uuid;
    if (!draftUuid) {
      throw new CommandExecutionError(`Qiita saveCreatingArticle returned no uuid: ${JSON.stringify(draftData)}`);
    }

    if (kwargs.draft) {
      return [{ status: 'draft', uuid: draftUuid, url: `https://qiita.com/drafts/${draftUuid}/edit` }];
    }

    // 2) 发布：公开 or 限定公开。input 字段照搬编辑器实际发出的 mutation。
    let article;
    if (kwargs.secret) {
      const d = await qiitaGql(page, PUBLISH_SECRET, {
        input: { uuid: draftUuid, title, rawBody: body, tagNames, slide: false },
      });
      article = d?.publishSecretArticle?.article;
    } else {
      const d = await qiitaGql(page, PUBLISH_PUBLIC, {
        input: {
          uuid: draftUuid, title, rawBody: body, tagNames, slide: false,
          tweetShare: !!kwargs['tweet-share'], adventCalendarItems: [],
        },
      });
      article = d?.publishPublicArticle?.article;
    }
    if (!article || !article.linkUrl) {
      throw new CommandExecutionError(`Qiita publish returned no article: ${JSON.stringify(article)}`);
    }
    return [{
      status: kwargs.secret ? 'published-secret' : 'published',
      uuid: article.uuid || draftUuid,
      url: article.linkUrl,
    }];
  },
});

// 删除一篇文章或一条草稿（用 publish 回来的 url，或草稿的 /drafts/<uuid> 地址）。
// 给 AI 做「发布后回滚 / 清理测试内容」用；走 web 编辑器同款 Rails 表单删除（见 gql.js qiitaDeleteByForm）。
cli({
  site: 'qiita',
  name: 'delete',
  access: 'write',
  description: 'Delete a Qiita article or draft by its URL (article linkUrl, or https://qiita.com/drafts/<uuid>).',
  domain: 'qiita.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'url', type: 'string', required: false, help: 'Article URL (e.g. https://qiita.com/<urlName>/items/<uuid>) or draft URL (https://qiita.com/drafts/<uuid>)' },
  ],
  columns: ['status', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for qiita delete');
    const url = String(kwargs.url ?? '').trim();
    if (!/^https:\/\/qiita\.com\/.+/.test(url)) {
      throw new ArgumentError('--url is required (a https://qiita.com/... article or draft URL)');
    }
    // 进同源页面拿 csrf meta，再提交删除表单。
    await page.goto('https://qiita.com/');
    await page.wait({ time: 1 });
    const res = await qiitaDeleteByForm(page, url);
    if (!res.ok) {
      throw new CommandExecutionError(`Qiita delete failed (HTTP ${res.status}) for ${url}`);
    }
    return [{ status: 'deleted', url }];
  },
});
