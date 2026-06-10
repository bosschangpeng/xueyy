// Cloudflare Pages Worker — 粤语学习助手
// 首次部署后访问域名，输入邀请码即可使用
// 设置环境变量 ALLOWED_CODES = code1,code2,code3

const AUTH_COOKIE = 'yue_token';
const COOKIE_DAYS = 60;

// TTS 代理
const TTS_SOURCES = [
  { name: 'youdao', url: (t) => `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(t)}&type=2`,
    headers: { 'Referer': 'https://dict.youdao.com/' } },
  { name: 'baidu', url: (t) => `https://fanyi.baidu.com/gettts?lan=yue&text=${encodeURIComponent(t)}&spd=5&source=web`,
    headers: { 'Referer': 'https://fanyi.baidu.com/' } },
];

const PAGE = (msg) => `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>粤语学习助手 · 验证</title>
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
.card .hint{font-size:.73rem;color:#c0c6d0;margin-top:16px}
</style></head>
<body><div class="card">
<h2>🗣 粤语学习助手</h2>
<div class="sub">请输入邀请码</div>
<input type="text" id="inp" placeholder="邀请码" maxlength="30" autocomplete="off">
<button id="btn">验证</button>
<div class="msg" id="msg">${msg||''}</div>
<div class="hint">仅限受邀用户使用</div>
</div>
<script>
document.getElementById('btn').onclick=()=>{const v=document.getElementById('inp').value.trim();if(!v){document.getElementById('msg').textContent='请输入邀请码';return;}window.location.href='/auth?code='+encodeURIComponent(v);};
document.getElementById('inp').onkeydown=e=>{if(e.key==='Enter')document.getElementById('btn').click();};
<\/script>
</body></html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // TTS 代理接口（不验证）
    if (url.pathname === '/tts') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' } });
      const text = url.searchParams.get('text');
      if (!text) return new Response('Missing text', { status: 400 });
      for (const src of TTS_SOURCES) {
        try {
          const resp = await fetch(src.url(text), { headers: src.headers });
          if (!resp.ok) continue;
          const buf = await resp.arrayBuffer();
          if (buf.byteLength > 100) return new Response(buf, { headers: { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' } });
        } catch (e) { continue; }
      }
      return new Response('TTS unavailable', { status: 502 });
    }

    // 验证邀请码
    if (url.pathname === '/auth') {
      const code = url.searchParams.get('code') || '';
      const allowed = (env.ALLOWED_CODES || '').split(',').map(s => s.trim()).filter(Boolean);
      if (allowed.includes(code)) {
        const headers = new Headers();
        headers.set('Set-Cookie', `${AUTH_COOKIE}=${code}; Path=/; Max-Age=${86400*COOKIE_DAYS}; SameSite=Lax`);
        headers.append('Location', '/');
        return new Response(null, { status: 302, headers });
      }
      return new Response(PAGE('邀请码无效'), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }

    // 检查认证
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(new RegExp(AUTH_COOKIE + '=([^;]+)'));
    const authed = match ? match[1] : '';
    const allowed = (env.ALLOWED_CODES || '').split(',').map(s => s.trim()).filter(Boolean);
    if (authed && allowed.includes(authed)) {
      return env.ASSETS.fetch(request);
    }

    // 未认证 → 返回登录页
    return new Response(PAGE(''), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
  },
};
