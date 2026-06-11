// 粤语学习助手 — 密码验证
// 设环境变量 ACCESS_PWD = 你的密码

const AUTH_COOKIE = 'yue_token';
const COOKIE_DAYS = 3650; // 10年

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
<div class="sub">请输入访问密码</div>
<input type="password" id="inp" placeholder="密码" maxlength="30" autocomplete="off">
<button id="btn">验证</button>
<div class="msg" id="msg">${msg||''}</div>
</div>
<script>
document.getElementById('btn').onclick=()=>{const v=document.getElementById('inp').value.trim();if(!v){document.getElementById('msg').textContent='请输入密码';return;}window.location.href='/auth?pwd='+encodeURIComponent(v);};
document.getElementById('inp').onkeydown=e=>{if(e.key==='Enter')document.getElementById('btn').click();};
<\/script>
</body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pwd = env.ACCESS_PWD || '';

    if (url.pathname === '/auth') {
      const inp = url.searchParams.get('pwd') || '';
      if (inp === pwd) {
        const headers = new Headers();
        headers.set('Set-Cookie', `${AUTH_COOKIE}=1; Path=/; Max-Age=${86400 * COOKIE_DAYS}; SameSite=Lax`);
        headers.set('Location', '/');
        return new Response(null, { status: 302, headers });
      }
      return new Response(PAGE('密码错误'), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }

    const cookie = request.headers.get('Cookie') || '';
    if (cookie.includes(AUTH_COOKIE + '=1')) return env.ASSETS.fetch(request);

    return new Response(PAGE(''), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
  },
};
