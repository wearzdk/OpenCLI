import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { gotoWritePage } from '../_shared/article/publish.js';
import { csdnProfile } from './article.js';

// ── CSDN 个人专栏列举 ───────────────────────────────────────────────────────
// CSDN 的「分类」其实是用户自己的「个人专栏」。`csdn article --category` 的合法值
// 必须来自本命令，禁止 AI 臆造专栏名。
// 接口：GET bizapi.csdn.net/blog/phoenix/console/v1/column/list?type=all（需 x-ca-* 签名，
// apiPath 末行带 query）。出处：terwer/siyuan-plugin-publisher csdnWebAdaptor getCategories。
cli({
    site: 'csdn',
    name: 'columns',
    access: 'read',
    description: '列出当前用户的 CSDN 个人专栏（id + 名称），供 `csdn article --category` 取合法专栏名。',
    domain: 'editor.csdn.net',
    strategy: Strategy.COOKIE,
    browser: true,
    columns: ['column_id', 'column_name', 'paid'],
    func: async (page) => {
        if (!page) throw new CommandExecutionError('CSDN 专栏列举需要浏览器会话');
        await gotoWritePage(page, csdnProfile.home);
        const data = await page.evaluate(
            "(async () => {"
            + "var API_KEY='203803574', API_SECRET='9znpamsyl2c7cdrr9sas0le9vbc3r6ba';"
            + "async function hmac(m,s){var e=new TextEncoder();var k=await crypto.subtle.importKey('raw',e.encode(s),{name:'HMAC',hash:'SHA-256'},false,['sign']);var sig=await crypto.subtle.sign('HMAC',k,e.encode(m));var b=new Uint8Array(sig),x='';for(var i=0;i<b.byteLength;i++)x+=String.fromCharCode(b[i]);return btoa(x);}"
            + "var nonce='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c==='x'?r:(r&0x3|0x8)).toString(16);});"
            + "var apiPath='/blog/phoenix/console/v1/column/list?type=all';"
            + "var signStr='GET\\n*/*\\n\\n\\n\\nx-ca-key:'+API_KEY+'\\nx-ca-nonce:'+nonce+'\\n'+apiPath;"
            + "var sig=await hmac(signStr,API_SECRET);"
            + "var res=await fetch('https://bizapi.csdn.net'+apiPath,{method:'GET',credentials:'include',headers:{'accept':'*/*','x-ca-key':API_KEY,'x-ca-nonce':nonce,'x-ca-signature':sig,'x-ca-signature-headers':'x-ca-key,x-ca-nonce'}});"
            + "var j=await res.json();"
            + "var out=[]; var lst=(j&&j.data&&j.data.list)||{};"
            + "(lst.column||[]).forEach(function(c){out.push({column_id:String(c.id),column_name:c.edit_title||c.title||'',paid:false});});"
            + "(lst.pay_column||[]).forEach(function(c){out.push({column_id:String(c.id),column_name:c.edit_title||c.title||'',paid:true});});"
            + "return out;"
            + "})()",
        );
        return Array.isArray(data) ? data : [];
    },
});
