// 粤语学习助手 — KV 绑定版验证
// 环境变量 ALLOWED_CODES = code1,code2,code3
// KV 命名空间绑定变量名 YUE_KV

const AUTH_COOKIE = 'yue_token';
const COOKIE_DAYS = 60;

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
<div class="hint">每个邀请码仅限一人使用</div>
</div>
<script>
document.getElementById('btn').onclick=()=>{const v=document.getElementById('inp').value.trim();if(!v){document.getElementById('msg').textContent='请输入邀请码';return;}window.location.href='/auth?code='+encodeURIComponent(v);};
document.getElementById('inp').onkeydown=e=>{if(e.key==='Enter')document.getElementById('btn').click();};
<\/script>
</body></html>`;

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 验证邀请码
    if (url.pathname === '/auth') {
      const code = url.searchParams.get('code') || '';
      const allowed = (env.ALLOWED_CODES || '').split(',').map(s => s.trim()).filter(Boolean);

      if (!allowed.includes(code)) {
        return new Response(PAGE('邀请码无效'), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
      }

      // KV 查是否已被占用
      const existing = await env.YUE_KV.get(code);
      if (existing) {
        return new Response(PAGE('该邀请码已被使用'), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
      }

      // 首次使用，生成 token 绑定
      const token = randomToken();
      await env.YUE_KV.put(code, token, { expirationTtl: 86400 * COOKIE_DAYS });

      const headers = new Headers();
      headers.set('Set-Cookie', `${AUTH_COOKIE}=${code}:${token}; Path=/; Max-Age=${86400 * COOKIE_DAYS}; SameSite=Lax; HttpOnly`);
      headers.set('Location', '/');
      return new Response(null, { status: 302, headers });
    }

    // 检查 cookie
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(new RegExp(AUTH_COOKIE + '=([^;]+)'));
    if (match) {
      const [code, token] = match[1].split(':');
      if (code && token) {
        const stored = await env.YUE_KV.get(code);
        if (stored === token) {
          return env.ASSETS.fetch(request);
        }
      }
    }

    // 未认证 → 返回登录页
    return new Response(PAGE(''), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
  },
};
