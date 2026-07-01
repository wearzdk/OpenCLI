/**
 * Bilibili 视频投稿（web 投稿）—— 完全在「真实浏览器登录态」里执行，复用客户端浏览器会话。
 *
 * 不再桥接外部 biliup 二进制（biliup 需 app access_token，web cookie 登录拿不到，已废弃）。
 * 忠实移植上游开源 Nemo2011/bilibili-api 的 `video_uploader.py`（纯 SESSDATA+bili_jct，无 app
 * token）：preupload → upos 分块上传 → /x/vu/web/add/v3 提交。接口/参数/字段 1:1 抄上游，不自行逆向。
 *
 * 为什么跑在浏览器里：环境绝对真实（住宅 IP/真实登录态/指纹，最强反风控）；upos 分块 PUT 跨域到
 * upos-*.bilivideo.com，B站官方 web 投稿页本就这么传、对 member.bilibili.com 放行了 CORS，真实页面里
 * 天然可用；SESSDATA 是 HttpOnly，credentials:'include' 自动带。
 *
 * 编排模型（关键，踩坑得来）：
 *   - opencli 浏览器会话在 **Node 侧长时间不发 evaluate（空闲数秒）时，活动标签会漂移到 data: 空白页**，
 *     window 全局随之清空。故：① 绝不把上传状态存 window 全局；② 绝不在步骤间 sleep。
 *   - 每步都是**自包含的短 evaluate**（把整段函数 .toString() 注进去，只吃传入的 a 参数 + 浏览器全局）；
 *     协议状态（upload_id / auth / url / 已传分块）全部**存在 Node 侧**，逐块回传。
 *   - 视频字节：CDP `setFileInput` 从磁盘塞进隐藏 <input>，各步 evaluate 现读 `input.files[0]`（DOM
 *     节点在不发生导航时一直在，不依赖 window）。分块 PUT 一块一次 evaluate、背靠背连发（无空闲→不漂移），
 *     每次 evaluate 远小于 30s（CDP_SEND_TIMEOUT），因此**任意大小的视频都不受单次 evaluate 上限约束**。
 *
 * 上游出处（逐函数核对 video_uploader.py）：_preupload / _get_upload_url / _upload_chunk /
 *   _complete_page / VideoMeta.__dict__ + _submit / module upload_cover；线路常量 data/video_uploader_lines.json。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { resolveVideoFile, resolveImageFile } from '../_shared/video-publish.js';

// 上游 data/video_uploader_lines.json（verbatim）。默认 bda2（百度云）。
const LINES = {
  bda2: { os: 'upos', upcdn: 'bda2', probe_version: 20221109 },
  bldsa: { os: 'upos', upcdn: 'bldsa', probe_version: 20221109 },
  qn: { os: 'upos', upcdn: 'qn', probe_version: 20221109 },
  ws: { os: 'upos', upcdn: 'ws', probe_version: 20221109 },
};
const DEFAULT_LINE = 'bda2';

// 登录态最少需要的三枚 cookie（SESSDATA 是 HttpOnly，CDP getCookies 仍可读到）。
const REQUIRED_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID'];

const UPLOAD_PAGE = 'https://member.bilibili.com/platform/home';
const HIDDEN_INPUT_ID = '__pp_bili_video_input';

/* eslint-disable */
// 以下函数仅被 .toString() 注入真实页面执行，引用的 window/document/fetch 都是浏览器全局；Node 里永不调用。

// preupload GET 拿 endpoint/auth/chunk_size/biz_id → POST 取 upload_id。返回给 Node 侧保存。
function PP_PREUPLOAD(a) {
  var inp = document.getElementById(a.inputId);
  if (!inp || !inp.files || !inp.files[0]) return { error: '文件未就绪（input 为空）' };
  var file = inp.files[0];
  var size = file.size;
  var line = a.line;
  return (async function () {
    try {
      var q = new URLSearchParams({
        profile: 'ugcfx/bup', name: file.name, size: String(size), r: line.os, ssl: '0',
        version: '2.14.0', build: '2100400', upcdn: line.upcdn, probe_version: String(line.probe_version),
      });
      var pre = await (await fetch('https://member.bilibili.com/preupload?' + q.toString(), {
        credentials: 'include', headers: { Referer: 'https://www.bilibili.com' },
      })).json();
      if (pre.OK !== 1) return { error: 'preupload 失败：' + JSON.stringify(pre) };
      var url = 'https:' + pre.endpoint + '/' + String(pre.upos_uri).replace(/^upos:\/\//, '');
      var iq = new URLSearchParams({
        uploads: '', output: 'json', profile: 'ugcfx/bup',
        filesize: String(size), partsize: String(pre.chunk_size), biz_id: String(pre.biz_id),
      });
      var ij = await (await fetch(url + '?' + iq.toString(), { method: 'POST', headers: { 'x-upos-auth': pre.auth } })).json();
      if (ij.OK !== 1) return { error: '获取 upload_id 失败：' + JSON.stringify(ij) };
      var chunkCount = Math.max(1, Math.ceil(size / pre.chunk_size));
      return {
        url: url, auth: pre.auth, uploadId: ij.upload_id, chunkSize: pre.chunk_size,
        bizId: pre.biz_id, size: size, name: file.name, total: chunkCount,
      };
    } catch (e) { return { error: 'preupload 异常：' + String((e && e.message) || e) }; }
  })();
}

// 上传单个分块（_upload_chunk 的 params verbatim）。一块一次 evaluate，背靠背连发。
function PP_PUT_CHUNK(a) {
  var inp = document.getElementById(a.inputId);
  if (!inp || !inp.files || !inp.files[0]) return { ok: false, error: '文件丢失（页面可能已导航）' };
  var file = inp.files[0];
  var off = a.idx * a.chunkSize;
  var blob = file.slice(off, Math.min(off + a.chunkSize, a.size));
  var real = blob.size;
  var p = new URLSearchParams({
    partNumber: String(a.idx + 1), uploadId: String(a.uploadId), chunk: String(a.idx),
    chunks: String(a.total), size: String(real), start: String(off), end: String(off + real), total: String(a.size),
  });
  return (async function () {
    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        var rr = await fetch(a.url + '?' + p.toString(), { method: 'PUT', headers: { 'x-upos-auth': a.auth }, body: blob });
        if (rr.status < 400) {
          var t = await rr.text();
          if (t === 'MULTIPART_PUT_SUCCESS' || t === '') return { ok: true };
        }
      } catch (e) {}
      await new Promise(function (rs) { setTimeout(rs, 800 * (attempt + 1)); });
    }
    return { ok: false, error: '分块 ' + a.idx + ' 多次重试仍失败' };
  })();
}

// _complete_page：合并分块，取 filename/cid。
function PP_COMPLETE(a) {
  var parts = [];
  for (var x = 1; x <= a.total; x++) parts.push({ partNumber: x, eTag: 'etag' });
  var cq = new URLSearchParams({
    output: 'json', name: a.name, profile: 'ugcfx/bup', uploadId: String(a.uploadId), biz_id: String(a.bizId),
  });
  return (async function () {
    try {
      var cj = await (await fetch(a.url + '?' + cq.toString(), {
        method: 'POST', headers: { 'x-upos-auth': a.auth, 'content-type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ parts: parts }),
      })).json();
      if (cj.OK !== 1) return { error: 'complete 失败：' + JSON.stringify(cj) };
      var filename = String(cj.key).replace(/^\//, '').replace(/\.[^.]+$/, '');
      return { filename: filename, cid: a.bizId };
    } catch (e) { return { error: 'complete 异常：' + String((e && e.message) || e) }; }
  })();
}

// 解析话题：按 tid 拉可用话题，找到 topic_id 对应项，取其 mission_id（对齐上游
// _check_topic_to_mission：mission_id 只能从 get_available_topics 配对，不让手填/臆造）。
function PP_RESOLVE_TOPIC(a) {
  return (async function () {
    try {
      var r = await fetch('https://member.bilibili.com/x/vupre/web/topic/type?type_id=' + encodeURIComponent(a.tid) + '&pn=0&ps=200', { credentials: 'include' });
      var j = await r.json();
      if (!j || j.code !== 0 || !j.data || !Array.isArray(j.data.topics)) {
        return { error: '获取话题列表失败：' + ((j && j.message) || ('code=' + (j && j.code))) };
      }
      var hit = null;
      for (var i = 0; i < j.data.topics.length; i++) {
        if (Number(j.data.topics[i].topic_id) === Number(a.topicId)) { hit = j.data.topics[i]; break; }
      }
      if (!hit) return { error: 'topic_id ' + a.topicId + ' 不在分区 ' + a.tid + ' 的可用话题里（用 bilibili topics --tid ' + a.tid + ' 查合法值）' };
      return { topicId: Number(hit.topic_id), missionId: hit.mission_id != null ? Number(hit.mission_id) : null, name: hit.topic_name || '' };
    } catch (e) { return { error: '解析话题异常：' + String((e && e.message) || e) }; }
  })();
}

// upload_cover：form-encoded，cover 为 data URI，附 csrf；返回 data.url。
function PP_COVER(a) {
  return (async function () {
    var m = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
    if (!m) return { error: '未找到 bili_jct CSRF token' };
    var csrf = decodeURIComponent(m[1]);
    try {
      var body = new URLSearchParams();
      body.append('cover', a.dataUri);
      body.append('csrf', csrf);
      var j = await (await fetch('https://member.bilibili.com/x/vu/web/cover/up', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
      })).json();
      if (!j || j.code !== 0 || !j.data || !j.data.url) return { error: '封面上传失败：' + (j && j.message ? j.message : JSON.stringify(j)) };
      return { url: j.data.url };
    } catch (e) { return { error: '封面上传异常：' + String((e && e.message) || e) }; }
  })();
}

// _submit：add/v3，csrf 同时在 query 和 body；json_body。
function PP_SUBMIT(a) {
  return (async function () {
    var m = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
    if (!m) return { error: '未找到 bili_jct CSRF token' };
    var csrf = decodeURIComponent(m[1]);
    var meta = a.meta;
    // 对齐上游 VideoMeta.__dict__ 的 None 剔除：只删值为 null/undefined 的字段，其余全量参数照发
    // （缺参易被风控打特征，故除 null 外一个都不省）。
    for (var k in meta) { if (meta[k] === null || meta[k] === undefined) delete meta[k]; }
    meta.csrf = csrf;
    try {
      var r = await fetch('https://member.bilibili.com/x/vu/web/add/v3?csrf=' + encodeURIComponent(csrf) + '&t=' + Date.now(), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' }, body: JSON.stringify(meta),
      });
      var j = await r.json();
      if (!j || j.code !== 0) return { error: 'add/v3 提交失败：' + (j && j.message ? j.message : '') + '（code=' + (j && j.code) + ' status=' + r.status + '）' };
      return { bvid: j.data && j.data.bvid, aid: j.data && j.data.aid };
    } catch (e) { return { error: 'add/v3 异常：' + String((e && e.message) || e) }; }
  })();
}
/* eslint-enable */

const callInPage = (page, fn, a) => page.evaluateWithArgs(`(${fn.toString()})(a)`, { a });

/** 读取本地图片为 data URI（封面用，浏览器侧无法读本地盘，故在 Node 侧编码后传入）。 */
function imageToDataUri(file) {
  const abs = resolveImageFile(file);
  const ext = path.extname(abs).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
  const b64 = fs.readFileSync(abs).toString('base64');
  return `data:${mime};base64,${b64}`;
}

/** 确认页面真的落在 member.bilibili.com 且登录态可用，返回 cookie map。 */
async function ensureLoggedInMember(page) {
  for (let i = 0; i < 8; i++) {
    await page.goto(UPLOAD_PAGE);
    await page.wait({ time: 1 });
    let href = '';
    try {
      href = String((await page.evaluate('location.href')) || '');
    } catch {
      href = '';
    }
    if (/^https?:\/\/member\.bilibili\.com\//.test(href)) {
      const cookies = await page.getCookies({ url: 'https://member.bilibili.com' });
      const jar = new Map();
      for (const c of Array.isArray(cookies) ? cookies : []) {
        if (c && typeof c.name === 'string') jar.set(c.name, String(c.value ?? ''));
      }
      const missing = REQUIRED_COOKIES.filter((n) => !jar.get(n));
      if (!missing.length) return jar;
      throw new AuthRequiredError('member.bilibili.com', `缺少 B站登录 cookie（${missing.join(', ')}）。请先在客户端登录哔哩哔哩。`);
    }
  }
  throw new AuthRequiredError('member.bilibili.com', '无法进入 B站创作中心（可能未登录或被风控）。请先在客户端登录哔哩哔哩。');
}

cli({
  site: 'bilibili',
  name: 'upload',
  access: 'write',
  description:
    '投稿视频到 B站（在真实浏览器登录态里走 web 投稿：preupload→upos 分块→add/v3）。默认仅 dry-run 校验，加 --execute 才真正上传并提交。',
  domain: 'member.bilibili.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'file', required: true, positional: true, help: '视频文件路径' },
    { name: 'title', help: '稿件标题（默认取文件名）' },
    { name: 'tid', type: 'number', required: true, help: '分区 id（B站 typeid，必填，禁止臆造）。合法值用 `bilibili partitions` 列举后取。' },
    { name: 'tag', required: true, help: '标签，逗号分隔（B站要求至少 1 个）' },
    { name: 'desc', help: '简介' },
    { name: 'topic', type: 'number', help: '参与话题的 topic_id（重要流量入口）。合法值用 `bilibili topics --tid <tid>` 列举，禁止臆造；mission_id 自动匹配。' },
    { name: 'cover', help: '封面图片路径（不传由 B站自动截取）' },
    { name: 'copyright', type: 'number', help: '1=自制 2=转载（默认 1）' },
    { name: 'source', help: '转载来源 URL（copyright=2 时必填）' },
    { name: 'dynamic', help: '同步发布的动态文案（可空）' },
    { name: 'no-reprint', type: 'boolean', help: '禁止转载（默认允许）' },
    { name: 'dtime', type: 'number', help: '定时发布的 10 位 unix 时间戳（可空=立即）' },
    { name: 'line', help: `上传线路：${Object.keys(LINES).join('/')}（默认 ${DEFAULT_LINE}）` },
    { name: 'concurrency', type: 'number', help: '分块并发数（默认 3）' },
    { name: 'execute', type: 'boolean', help: '真正投稿；不带则只做 dry-run 校验' },
  ],
  columns: ['status', 'title', 'bvid', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('bilibili upload 需要浏览器会话');

    // ── 参数校验（缺必填即抛 typed error，绝不 fallback 默认值）────────────────
    const videoPath = resolveVideoFile(String(kwargs.file ?? ''));
    const title = String(kwargs.title ?? '').trim() || path.basename(videoPath).replace(/\.[^.]+$/, '');

    const tags = String(kwargs.tag ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!tags.length) throw new ArgumentError('B站投稿至少需要 1 个标签，用 --tag 传（逗号分隔）');

    if (kwargs.tid == null || kwargs.tid === '' || !Number.isFinite(Number(kwargs.tid))) {
      throw new ArgumentError('必须用 --tid 指定分区 id（数字）。合法值用 `bilibili partitions` 列举，禁止臆造。');
    }
    const tid = Number(kwargs.tid);

    const copyright = kwargs.copyright != null && kwargs.copyright !== '' ? Number(kwargs.copyright) : 1;
    if (copyright !== 1 && copyright !== 2) throw new ArgumentError('--copyright 只能是 1(自制) 或 2(转载)');
    const source = String(kwargs.source ?? '').trim();
    if (copyright === 2 && !source) throw new ArgumentError('转载（copyright=2）必须用 --source 提供转载来源');

    if (kwargs.cover) resolveImageFile(String(kwargs.cover)); // 提前校验封面存在/格式

    const lineKey = String(kwargs.line ?? DEFAULT_LINE);
    const line = LINES[lineKey];
    if (!line) throw new ArgumentError(`未知上传线路「${lineKey}」，可选：${Object.keys(LINES).join('/')}`);

    const concurrency = kwargs.concurrency != null && kwargs.concurrency !== '' ? Number(kwargs.concurrency) : 3;

    // ── 登录态确认（真实浏览器，member.bilibili.com 源）──────────────────────
    await ensureLoggedInMember(page);

    if (!kwargs.execute) {
      return {
        status: 'dry-run',
        title,
        bvid: '',
        url: `校验通过：登录态有效、视频就绪、分区 ${tid}、标签 [${tags.join(', ')}]、版权 ${copyright === 1 ? '自制' : '转载'}。加 --execute 真正投稿。`,
      };
    }

    // ── 1) 注入隐藏 input + CDP 把本地视频塞进去 ──────────────────────────────
    if (!page.setFileInput) {
      throw new CommandExecutionError('浏览器扩展不支持 CDP 文件上传（set-file-input），无法上传视频；请升级 PublishPort 客户端/扩展');
    }
    await page.evaluate(
      `(() => { var id=${JSON.stringify(HIDDEN_INPUT_ID)}; var el=document.getElementById(id); if(!el){ el=document.createElement('input'); el.type='file'; el.id=id; el.style.cssText='position:fixed;left:-9999px;top:0;'; document.body.appendChild(el);} el.value=''; return true; })()`,
    );
    await page.setFileInput([videoPath], `#${HIDDEN_INPUT_ID}`);

    // ── 2) preupload + 取 upload_id（状态存 Node 侧）──────────────────────────
    const pre = await callInPage(page, PP_PREUPLOAD, { inputId: HIDDEN_INPUT_ID, line });
    if (!pre || pre.error) throw new CommandExecutionError(`B站 preupload 失败：${(pre && pre.error) || '无返回'}`);

    // ── 3) 分块上传：一块一次短 evaluate，背靠背连发（无空闲→标签不漂移，且每次远小于 30s）──
    for (let i = 0; i < pre.total; i++) {
      const r = await callInPage(page, PP_PUT_CHUNK, {
        inputId: HIDDEN_INPUT_ID,
        url: pre.url,
        auth: pre.auth,
        uploadId: pre.uploadId,
        idx: i,
        total: pre.total,
        size: pre.size,
        chunkSize: pre.chunkSize,
      });
      if (!r || !r.ok) throw new CommandExecutionError(`B站分块上传失败（${i + 1}/${pre.total}）：${(r && r.error) || '无返回'}`);
    }

    // ── 4) 合并分块 → filename/cid ───────────────────────────────────────────
    const comp = await callInPage(page, PP_COMPLETE, {
      url: pre.url,
      auth: pre.auth,
      uploadId: pre.uploadId,
      bizId: pre.bizId,
      name: pre.name,
      total: pre.total,
    });
    if (!comp || comp.error || !comp.filename) throw new CommandExecutionError(`B站 complete 失败：${(comp && comp.error) || '未拿到 filename'}`);

    // ── 5) 封面（可选）──────────────────────────────────────────────────────
    let coverUrl = '';
    if (kwargs.cover) {
      const dataUri = imageToDataUri(String(kwargs.cover));
      const cov = await callInPage(page, PP_COVER, { dataUri });
      if (!cov || cov.error || !cov.url) throw new CommandExecutionError(`B站封面上传失败：${(cov && cov.error) || '未拿到 url'}`);
      coverUrl = cov.url;
    }

    // ── 6) 话题（可选，重要流量入口）：解析 topic_id → mission_id（自动配对，禁手填/臆造）──
    let topicId = null;
    let missionId = null;
    if (kwargs.topic != null && kwargs.topic !== '') {
      if (!Number.isFinite(Number(kwargs.topic))) throw new ArgumentError('--topic 必须是 topic_id 数字，用 `bilibili topics --tid <tid>` 取合法值');
      const tp = await callInPage(page, PP_RESOLVE_TOPIC, { tid, topicId: Number(kwargs.topic) });
      if (!tp || tp.error) throw new CommandExecutionError(`B站话题解析失败：${(tp && tp.error) || '无返回'}`);
      topicId = tp.topicId;
      missionId = tp.missionId;
    }

    // ── 7) 构造 add/v3 meta：**逐字段复刻上游 VideoMeta.__dict__ 的全量参数**，未用到的可选项置 null，
    //      交由页面内 PP_SUBMIT 按上游规则剔除 null（除 null 外一个参数都不省——缺参易被风控打特征）。──
    const dtime = kwargs.dtime != null && kwargs.dtime !== '' ? Number(kwargs.dtime) : null;
    const meta = {
      title,
      copyright,
      tid,
      tag: tags.join(','),
      mission_id: missionId, // null → 剔除（无话题时）
      topic_id: topicId, // null → 剔除（无话题时）
      // topic_detail 仅在真参与话题时发；无话题路径与已验证成功的 BV1VHTe6rEZz 完全一致，不擅动。
      topic_detail: topicId != null ? { from_topic_id: topicId, from_source: 'arc.web.recommend' } : null,
      desc_format_id: 9999,
      desc: String(kwargs.desc ?? ''),
      dtime, // null → 剔除
      recreate: -1,
      dynamic: String(kwargs.dynamic ?? ''), // 与已验证路径一致：空时发 ""（不省）
      interactive: 0,
      act_reserve_create: 0,
      no_disturbance: 0,
      porder: null, // 剔除（无商单）
      adorder_type: 9,
      no_reprint: kwargs['no-reprint'] ? 1 : 0,
      subtitle: { open: 0, lan: '' },
      neutral_mark: null, // 剔除（无创作者声明）
      dolby: 0,
      lossless_music: 0,
      up_selection_reply: false, // 对齐上游 = up_close_reply（默认 false）
      up_close_reply: false,
      up_close_danmu: false,
      web_os: 1,
      source: copyright === 2 ? source : null, // 仅转载带来源，否则剔除
      watermark: { state: 0 },
      cover: coverUrl,
      videos: [{ title, desc: '', filename: comp.filename, cid: comp.cid }],
    };

    const sub = await callInPage(page, PP_SUBMIT, { meta });
    if (!sub || sub.error) throw new CommandExecutionError(`B站 ${(sub && sub.error) || 'add/v3 无返回'}`);
    const bvid = sub.bvid ? String(sub.bvid) : '';

    return {
      status: kwargs.dtime ? '✅ 定时投稿已提交' : '✅ 投稿成功',
      title,
      bvid,
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : '（已提交，稍后在创作中心查看）',
    };
  },
});
