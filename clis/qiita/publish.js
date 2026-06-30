import * as fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { qiitaFetch, qiitaToken } from './auth.js';

// Qiita 投稿の発行 / 更新。POST /api/v2/items（新規）/ PATCH /api/v2/items/{id}（更新）。
// 参考官方 increments/qiita-cli。原子能力：md 正文、tags(必填，≥1)、private/public、create/update。

function resolveBody(kwargs) {
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

// Qiita タグ：name のみ必須、versions は任意。少なくとも 1 つ必要。
function resolveTags(raw) {
  const tags = String(raw ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return tags.map((name) => ({ name, versions: [] }));
}

cli({
  site: 'qiita',
  name: 'publish',
  access: 'write',
  description: 'Publish or update a Qiita item (markdown). Tags are required; public by default.',
  domain: 'qiita.com',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'title', type: 'string', required: false, help: 'Item title (required for new items)' },
    { name: 'body', type: 'string', required: false, help: 'Item body in Markdown (or use --body-file)' },
    { name: 'body-file', type: 'string', required: false, help: 'Path to a Markdown file for the body' },
    { name: 'tags', type: 'string', required: false, help: 'Comma-separated tags (REQUIRED, at least 1)' },
    { name: 'private', type: 'boolean', required: false, default: false, help: 'Post as private (default: public)' },
    { name: 'id', type: 'string', required: false, help: 'Existing item id to update (PATCH instead of POST)' },
  ],
  columns: ['status', 'id', 'url', 'private'],
  func: async (kwargs) => {
    const token = qiitaToken();
    const id = kwargs.id ? String(kwargs.id).trim() : '';
    const body = resolveBody(kwargs);
    const tags = resolveTags(kwargs.tags);

    if (!id) {
      if (!kwargs.title) throw new ArgumentError('--title is required when creating a new item');
      if (body === undefined) throw new ArgumentError('--body or --body-file is required when creating a new item');
      if (tags.length === 0) throw new ArgumentError('--tags is required (Qiita items need at least one tag)');
    }

    const item = {};
    if (kwargs.title !== undefined) item.title = String(kwargs.title);
    if (body !== undefined) item.body = body;
    if (kwargs.tags !== undefined && kwargs.tags !== null && kwargs.tags !== '') item.tags = tags;
    if (kwargs.private !== undefined) item.private = !!kwargs.private;

    const out = id
      ? await qiitaFetch(token, `/items/${id}`, { method: 'PATCH', body: JSON.stringify(item) })
      : await qiitaFetch(token, '/items', { method: 'POST', body: JSON.stringify(item) });

    return [{
      status: id ? 'updated' : 'created',
      id: out.id,
      url: out.url ?? '',
      private: out.private ?? false,
    }];
  },
});
