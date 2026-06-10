// 粤语学习助手 — 访问控制 Worker
// 使用方式：在 Cloudflare Pages → Settings → Environment Variables
// 添加 ALLOWED_USERS = wxid_aaa,wxid_bbb,wxid_ccc
// (逗号分隔已授权的微信号)

const AUTH_COOKIE = 'yue_auth';
const BYPASS_HEADER = 'X-Auth-Bypass';

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>粤语学习助手 · 验证</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:#f0f4fa;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:24px}
.card{background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 4px 30px rgba(0,0,0,.08);
width:100%;max-width:380px;text-align:center}
.card h2{font-size:1.3rem;color:#4A90D9;margin-bottom:4px}
.card p{font-size:.85rem;color:#7f8c8d;margin-bottom:20px}
.card input{width:100%;padding:12px 16px;border:2px solid #e0e4e8;border-radius:10px;font-size:1rem;
outline:none;transition:border-color .2s;box-sizing:border-box}
.card input:focus{border-color:#4A90D9}
.card button{width:100%;margin-top:14px;padding:12px;border:none;border-radius:10px;
background:#4A90D9;color:#fff;font-size:1rem;font-weight:600;cursor:pointer;transition:background .15s}
.card button:hover{background:#357ABD}
.card .error{color:#e74c3c;font-size:.8rem;margin-top:10px;min-height:1.2em}
.card .hint{font-size:.73rem;color:#c0c6d0;margin-top:14px}
</style></head>
<body>
<div class="card">
<h2>🗣 粤语学习助手</h2>
<p>请输入你被授权的微信号</p>
<input type="text" id="idInput" placeholder="微信号" maxlength="20" autocomplete="off">
<button id="authBtn">验证</button>
<div class="error" id="errorMsg"></div>
<div class="hint">仅限受邀用户使用</div>
</div>
<script>
document.getElementById('authBtn').onclick = () => {
  const val = document.getElementById('idInput').value.trim();
  if (!val) { document.getElementById('errorMsg').textContent = '请输入微信号'; return; }
  window.location.href = '/auth?wechat=' + encodeURIComponent(val);
};
document.getElementById('idInput').onkeydown = (e) => {
  if (e.key === 'Enter') document.getElementById('authBtn').click();
};
<\/script>
</body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 认证回调
    if (url.pathname === '/auth') {
      const allowed = (env.ALLOWED_USERS || '').split(',').filter(Boolean);
      const wechat = url.searchParams.get('wechat') || '';
      if (allowed.includes(wechat)) {
        const headers = new Headers();
        headers.set('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(wechat)}; Path=/; Max-Age=2592000; SameSite=Lax`);
        headers.set('Location', '/');
        return new Response(null, { status: 302, headers });
      }
      const errPage = LOGIN_PAGE.replace(
        'class="error" id="errorMsg"></div>',
        'class="error" id="errorMsg">微信号未获授权，请联系管理员</div>'
      );
      return new Response(errPage, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }

    // 已认证用户 → 正常返回静态资源
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(new RegExp(AUTH_COOKIE + '=([^;]+)'));
    const user = match ? decodeURIComponent(match[1]) : '';
    const allowed = (env.ALLOWED_USERS || '').split(',').filter(Boolean);
    if (user && allowed.includes(user)) {
      return env.ASSETS.fetch(request);
    }

    // 首页未认证 → 显示登录页
    if (url.pathname === '/') {
      return new Response(LOGIN_PAGE, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }

    // 其他资源未认证 → 401
    return new Response('Unauthorized', { status: 401 });
  },
};
