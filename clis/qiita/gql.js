/**
 * Qiita web GraphQL —— [pp-only] 在已登录的 qiita.com 页面内打 `POST /graphql`。
 *
 * 鉴权：同源 cookie（`_qiita_login_session`）+ `X-CSRF-Token`（取 `meta[name=csrf-token]`）。
 * 这是 Qiita 自家 web 编辑器用的端点；草稿/公开/限定公开各走不同 mutation（见 publish.js）。
 *
 * 请求头照搬 Qiita 自家 v3 编辑器 bundle（cdn.qiita.com/assets/public/v3-editor-bundle-*.min.js）的
 * Apollo HttpLink：除 `X-CSRF-Token` 外还带 `X-Requested-With: XMLHttpRequest`（Rails 的 AJAX 闸门，
 * 写操作缺它会被服务端拒）。读 viewer 之类纯查询可有可无，统一带上最稳。
 */
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const ENDPOINT = 'https://qiita.com/graphql';

/**
 * 在页面内执行一次 GraphQL 请求，归一错误。
 * @returns {Promise<object>} GraphQL `data`
 * @throws {AuthRequiredError} 命中 "Login required" 等鉴权错误
 * @throws {CommandExecutionError} 其它 HTTP / GraphQL 错误
 */
export async function qiitaGql(page, query, variables = {}) {
  const res = await page.evaluate(`(async () => {
    try {
      var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content;
      if (!csrf) return { kind: 'auth', detail: 'no csrf-token meta — not logged in?' };
      var r = await fetch(${JSON.stringify(ENDPOINT)}, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ query: ${JSON.stringify(query)}, variables: ${JSON.stringify(variables)} }),
      });
      var text = await r.text();
      var data = null; try { data = JSON.parse(text); } catch (e) {}
      if (r.status === 401 || r.status === 403) return { kind: 'auth', detail: 'HTTP ' + r.status };
      if (!r.ok) return { kind: 'http', status: r.status, detail: text.slice(0, 300) };
      return { kind: 'ok', body: data };
    } catch (e) { return { kind: 'exception', detail: String(e && e.message || e) }; }
  })()`);

  if (res?.kind === 'auth') throw new AuthRequiredError('qiita.com', `Not logged in (${res.detail}). Run \`opencli qiita login\`.`);
  if (res?.kind === 'http') throw new CommandExecutionError(`Qiita GraphQL failed: HTTP ${res.status} ${res.detail}`);
  if (res?.kind === 'exception') throw new CommandExecutionError(`Qiita GraphQL error: ${res.detail}`);
  if (res?.kind !== 'ok' || !res.body) throw new CommandExecutionError(`Unexpected Qiita response: ${JSON.stringify(res)}`);

  const body = res.body;
  if (Array.isArray(body.errors) && body.errors.length) {
    const msg = body.errors.map((e) => e.message).join('; ');
    if (/login required|unauthor|not authenticated/i.test(msg)) {
      throw new AuthRequiredError('qiita.com', `Qiita auth error: ${msg}`);
    }
    throw new CommandExecutionError(`Qiita GraphQL error: ${msg}`);
  }
  return body.data || {};
}

/**
 * 删除一篇已发布文章 / 一条草稿（页面内 Rails 表单提交）。
 *
 * Qiita web 没有「删除」GraphQL mutation；删除按钮走 Rails-UJS 的表单 POST：
 *   POST <targetUrl>  body: `_method=delete` + `authenticity_token=<csrf>`
 * 照搬自 Qiita 文章页 bundle（v3-article-bundle-*.min.js）的 `submitForm({action,method:'delete'})`
 * 与通用 rails-ujs `handleMethod`（注入隐藏 input `_method` / `authenticity_token`）。
 * - 文章：targetUrl 用 publish 回来的 `linkUrl`（形如 `https://qiita.com/<urlName>/items/<uuid>`）。
 * - 草稿：targetUrl 用 `https://qiita.com/drafts/<uuid>`。
 * 成功返回 302 重定向（fetch redirect:'manual' 下表现为 status 0 / opaqueredirect）。
 *
 * @returns {Promise<{ok: boolean, status: number}>}
 */
export async function qiitaDeleteByForm(page, targetUrl) {
  const res = await page.evaluate(`(async () => {
    try {
      var meta = document.querySelector('meta[name="csrf-token"]');
      var token = meta && meta.content;
      if (!token) return { kind: 'auth' };
      var r = await fetch(${JSON.stringify(targetUrl)}, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '_method=delete&authenticity_token=' + encodeURIComponent(token),
        redirect: 'manual',
      });
      // 302 跳转 = 删除成功；opaqueredirect(status 0)/2xx/3xx 都视为成功，4xx/5xx 视为失败。
      var ok = r.type === 'opaqueredirect' || r.status === 0 || (r.status >= 200 && r.status < 400);
      return { kind: 'done', ok: ok, status: r.status };
    } catch (e) { return { kind: 'exception', detail: String(e && e.message || e) }; }
  })()`);

  if (res?.kind === 'auth') throw new AuthRequiredError('qiita.com', 'Not logged in. Run `opencli qiita login`.');
  if (res?.kind === 'exception') throw new CommandExecutionError(`Qiita delete error: ${res.detail}`);
  return { ok: !!res?.ok, status: res?.status ?? -1 };
}

/** 当前登录用户（urlName / name / originalId）。匿名时抛 AuthRequiredError。 */
export async function qiitaViewer(page) {
  const data = await qiitaGql(page, '{ viewer { urlName name originalId } }');
  if (!data.viewer || !data.viewer.urlName) {
    throw new AuthRequiredError('qiita.com', 'Qiita viewer empty — not logged in');
  }
  return data.viewer;
}
