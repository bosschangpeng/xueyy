// 粤语学习助手 — 密码 + 邀请码双验证 + MiniMax TTS代理
// ACCESS_PWD = 管理员密码（永久有效，不消耗）
// ALLOWED_CODES = 邀请码列表（一人一码，KV自动标记已用）
// MINIMAX_API_KEY = MiniMax API Key
// MINIMAX_GROUP_ID = MiniMax Group ID
// KV绑定变量名 YUE_KV

const AUTH_COOKIE = 'yue_token';
const COOKIE_DAYS = 3650;

const PAGE = (msg) => `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>粤语学习助手</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:#f0f4fa;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:24px}
.card{background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 4px 30px rgba(0,0,0,.08);width:100%;max-width:380px;text-align:center}
.card h2{font-size:1.3rem;color:#4A90D9;margin-bottom:4px}
.card .sub{font-size:.82rem;color:#7f8c8d;margin-bottom:20px}
.card input{width:100%;padding:11px 14px;border:2px solid #e0e4e8;border-radius:8px;font-size:.95rem;outline:none;transition:border-color .2s;box-sizing:border-box}
.card input:focus{border-color:#4A90D9}
.card button{width:100%;margin-top:12px;padding:12px;border:none;border-radius:8px;background:#4A90D9;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
.card .msg{color:#e74c3c;font-size:.8rem;margin-top:12px;min-height:1.2em}
</style></head>
<body><div class="card">
<h2>🗣 粤语学习助手</h2>
<div class="sub">请输入密码或邀请码</div>
<input type="text" id="inp" placeholder="管理员密码 / 邀请码" maxlength="30" autocomplete="off">
<button id="btn">验证</button>
<div class="msg" id="msg">${msg||''}</div>
</div>
<script>
document.getElementById('btn').onclick=()=>{const v=document.getElementById('inp').value.trim();if(!v){document.getElementById('msg').textContent='请输入密码或邀请码';return;}window.location.href='/auth?code='+encodeURIComponent(v);};
document.getElementById('inp').onkeydown=e=>{if(e.key==='Enter')document.getElementById('btn').click();};
<\/script>
</body></html>`;

function token() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2,'0')).join('');
}

async function checkAuth(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(AUTH_COOKIE + '=([^;]+)'));
  if (!m) return false;
  const val = m[1];
  if (val.startsWith('admin:')) return true;
  if (env.YUE_KV) {
    const [code, tok] = val.split(':');
    if (code && tok) {
      const stored = await env.YUE_KV.get(code);
      return stored === tok;
    }
  }
  return val === '1';
}

async function minimaxTts(env, body) {
  const apiKey = env.MINIMAX_API_KEY || '';
  const groupId = env.MINIMAX_GROUP_ID || '';
  if (!apiKey || !groupId) {
    return new Response(JSON.stringify({error:'MiniMax not configured'}), {status:500,headers:{'Content-Type':'application/json'}});
  }
  const resp = await fetch('https://api.minimax.chat/v1/t2a_v2?GroupId=' + groupId, {
    method: 'POST',
    headers: {'Authorization':'Bearer '+apiKey,'Content-Type':'application/json'},
    body: JSON.stringify({
      model: 'speech-2.8-hd',
      text: body.text,
      stream: false,
      language_boost: 'Chinese,Yue',
      voice_setting: {voice_id: body.voice||'Cantonese_GentleLady', speed: body.speed||1.0, vol:1.0, pitch:0},
      audio_setting: {sample_rate:32000, bitrate:128000, format:'mp3', channel:1},
      subtitle_enable: false,
    }),
  });
  if (!resp.ok) {
    return new Response(JSON.stringify({error:'MiniMax API '+resp.status}), {status:500,headers:{'Content-Type':'application/json'}});
  }
  const data = await resp.json();
  if (data.base_resp?.status_code !== 0) {
    return new Response(JSON.stringify({error:data.base_resp?.status_msg||'TTS error'}), {status:500,headers:{'Content-Type':'application/json'}});
  }
  const audioB64 = data.data?.audio || '';
  const audioBytes = Uint8Array.from(atob(audioB64), c=>c.charCodeAt(0));
  return new Response(audioBytes, {
    headers: {'Content-Type':'audio/mpeg','Cache-Control':'public,max-age=31536000,immutable','Content-Length':audioBytes.length.toString()},
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const adminPwd = env.ACCESS_PWD || '';
    const allowedCodes = (env.ALLOWED_CODES || '').split(',').map(s => s.trim()).filter(Boolean);
    const kv = env.YUE_KV;

    if (url.pathname === '/auth') {
      const code = url.searchParams.get('code') || '';

      if (adminPwd && code === adminPwd) {
        const headers = new Headers();
        headers.set('Set-Cookie', `${AUTH_COOKIE}=admin:${token()}; Path=/; Max-Age=${86400 * COOKIE_DAYS}; SameSite=Lax`);
        headers.set('Location', '/');
        return new Response(null, { status: 302, headers });
      }

      if (!allowedCodes.includes(code)) {
        return new Response(PAGE('邀请码无效'), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
      }

      if (kv) {
        const existing = await kv.get(code);
        if (existing) {
          return new Response(PAGE('该邀请码已被使用'), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
        }
        const tok = token();
        await kv.put(code, tok, { expirationTtl: 86400 * COOKIE_DAYS });
        const headers = new Headers();
        headers.set('Set-Cookie', `${AUTH_COOKIE}=${code}:${tok}; Path=/; Max-Age=${86400 * COOKIE_DAYS}; SameSite=Lax`);
        headers.set('Location', '/');
        return new Response(null, { status: 302, headers });
      }

      const headers = new Headers();
      headers.set('Set-Cookie', `${AUTH_COOKIE}=1; Path=/; Max-Age=${86400 * COOKIE_DAYS}; SameSite=Lax`);
      headers.set('Location', '/');
      return new Response(null, { status: 302, headers });
    }

    // 调试端点：测试 Worker → MiniMax 连通性
    if (url.pathname === '/debug-tts') {
      const results = [];
      const apiKey = env.MINIMAX_API_KEY || '';
      const groupId = env.MINIMAX_GROUP_ID || '';
      results.push('Key: ' + (apiKey ? '已设('+apiKey.slice(0,6)+'...)' : '未设'));
      results.push('Group: ' + (groupId ? groupId : '未设'));
      if (!apiKey || !groupId) {
        return new Response(results.join(' | '), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
      }
      const voices = ['Cantonese_GentleLady', 'Cantonese_podacast_host_1'];
      for (const vid of voices) {
        try {
          const start = Date.now();
          const resp = await fetch('https://api.minimax.chat/v1/t2a_v2?GroupId=' + groupId, {
            method: 'POST',
            headers: {'Authorization':'Bearer '+apiKey,'Content-Type':'application/json'},
            body: JSON.stringify({
              model: 'speech-2.8-hd',
              text: '你好',
              stream: false,
              language_boost: 'Chinese,Yue',
              voice_setting: {voice_id: vid, speed:1, vol:1, pitch:0},
              audio_setting: {sample_rate:32000, bitrate:128000, format:'mp3', channel:1},
              subtitle_enable: false,
            }),
          });
          const elapsed = Date.now() - start;
          const data = await resp.json();
          const ok = resp.ok && data.base_resp?.status_code === 0;
          results.push(vid + ' → ' + (ok ? 'OK('+elapsed+'ms)' : 'FAIL:'+(data.base_resp?.status_msg||resp.status)));
          if (ok) break;
        } catch (e) {
          results.push(vid + ' → ERR:' + e.message);
        }
      }
      return new Response(results.join(' | '), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    }

    // MiniMax TTS 代理
    if (url.pathname === '/tts') {
      // HEAD 检测 MiniMax 是否配置
      if (request.method === 'HEAD') {
        return new Response(null, { status: (env.MINIMAX_API_KEY && env.MINIMAX_GROUP_ID) ? 200 : 500 });
      }
      // POST 代理到 MiniMax
      if (request.method === 'POST') {
        if (!(await checkAuth(request, env))) {
          return new Response('Unauthorized', { status: 401 });
        }
        try {
          return await minimaxTts(env, await request.json());
        } catch (e) {
          return new Response(JSON.stringify({error:e.message}), {status:500,headers:{'Content-Type':'application/json'}});
        }
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // 检查 cookie — 放行页面资源
    if (await checkAuth(request, env)) {
      return env.ASSETS.fetch(request);
    }

    return new Response(PAGE(''), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
  },
};
