// 粤语学习助手 — 邀请码访问控制
// 设置环境变量 ALLOWED_CODES = code1,code2,code3
// 每个邀请码可以给一个人用，用完作废

const AUTH_COOKIE = 'yue_token';

const LOGIN_PAGE = (msg) => `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>粤语学习助手 · 验证</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:#f0f4fa;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:24px}
.card{background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 4px 30px rgba(0,0,0,.08);
width:100%;max-width:380px;text-align:center}
.card h2{font-size:1.3rem;color:#4A90D9;margin-bottom:4px;line-height:1.4}
.card .sub{font-size:.85rem;color:#7f8c8d;margin-bottom:20px}
.card input{width:100%;padding:12px 16px;border:2px solid #e0e4e8;border-radius:10px;font-size:1rem;
outline:none;transition:border-color .2s;box-sizing:border-box}
.card input:focus{border-color:#4A90D9}
.card button{width:100%;margin-top:14px;padding:12px;border:none;border-radius:10px;
background:#4A90D9;color:#fff;font-size:1rem;font-weight:600;cursor:pointer;transition:background .15s}
.card button:hover{background:#357ABD}
.card .msg{color:#e74c3c;font-size:.8rem;margin-top:12px;min-height:1.2em}
.card .hint{font-size:.73rem;color:#c0c6d0;margin-top:16px}
</style></head>
<body>
<div class="card">
<h2>🗣 粤语学习助手</h2>
<div class="sub">请输入邀请码</div>
<input type="text" id="codeInput" placeholder="邀请码" maxlength="20" autocomplete="off">
<button id="authBtn">验证</button>
<div class="msg" id="msg">${msg || ''}</div>
<div class="hint">仅限受邀用户使用</div>
</div>
<script>
document.getElementById('authBtn').onclick = () => {
  const val = document.getElementById('codeInput').value.trim();
  if (!val) { document.getElementById('msg').textContent = '请输入邀请码'; return; }
  window.location.href = '/auth?code=' + encodeURIComponent(val);
};
document.getElementById('codeInput').onkeydown = (e) => {
  if (e.key === 'Enter') document.getElementById('authBtn').click();
};
<\/script>
</body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 验证邀请码
    if (url.pathname === '/auth') {
      const code = url.searchParams.get('code') || '';
      const allowed = (env.ALLOWED_CODES || env.ALLOWED_USERS || '').split(',').filter(Boolean);

      if (allowed.includes(code)) {
        const headers = new Headers();
        headers.set('Set-Cookie', `${AUTH_COOKIE}=${code}; Path=/; Max-Age=2592000; SameSite=Lax`);
        headers.set('Location', '/');
        return new Response(null, { status: 302, headers });
      }
      return new Response(LOGIN_PAGE('邀请码无效'), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }

    // 检查认证
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(new RegExp(AUTH_COOKIE + '=([^;]+)'));
    const authed = match ? match[1] : '';
    const allowed = (env.ALLOWED_CODES || env.ALLOWED_USERS || '').split(',').filter(Boolean);

    if (authed && allowed.includes(authed)) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(LOGIN_PAGE(''), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }
    return new Response(null, { status: 302, headers: { Location: '/' } });
  },
};
