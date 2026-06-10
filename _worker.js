// 粤语学习助手 — 微信扫码登录验证
// 需要设置环境变量：
//   WECHAT_APPID      — 微信开放平台网站应用的 AppID
//   WECHAT_APPSECRET  — 微信开放平台网站应用的 AppSecret
//   ALLOWED_USERS     — 允许访问的微信 UnionID，逗号分隔

const AUTH_COOKIE = 'yue_token';
const COOKIE_MAX_AGE = 2592000; // 30天

const LOGIN_PAGE = (error) => `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>粤语学习助手 · 微信登录</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:#f0f4fa;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:24px}
.card{background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 4px 30px rgba(0,0,0,.08);
width:100%;max-width:400px;text-align:center}
.card h2{font-size:1.3rem;color:#4A90D9;margin-bottom:4px}
.card p{font-size:.85rem;color:#7f8c8d;margin-bottom:24px;line-height:1.5}
.card .btn{display:inline-flex;align-items:center;gap:8px;padding:12px 36px;border:none;border-radius:10px;
background:#07C160;color:#fff;font-size:1rem;font-weight:600;cursor:pointer;text-decoration:none;transition:background .15s}
.card .btn:hover{background:#06AD56}
.card .btn:active{transform:scale(.98)}
.card .error{color:#e74c3c;font-size:.8rem;margin-top:14px}
.card .hint{font-size:.73rem;color:#c0c6d0;margin-top:20px}
</style></head>
<body>
<div class="card">
<h2>🗣 粤语学习助手</h2>
<p>使用微信扫码登录<br>仅限受邀用户使用</p>
<a class="btn" href="/auth/wechat">${'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="4"/><path d="M12 6v12M6 12h12"/></svg>'} 微信登录</a>
${error ? `<div class="error">${error}</div>` : ''}
<div class="hint">微信开放平台身份验证</div>
</div>
</body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 微信 OAuth 回调
    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response(LOGIN_PAGE('登录失败：未获取到授权码'), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });

      // 用 code 换 access_token
      const tokenRes = await fetch(
        `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${env.WECHAT_APPID}&secret=${env.WECHAT_APPSECRET}&code=${code}&grant_type=authorization_code`
      );
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        return new Response(LOGIN_PAGE('登录失败：access_token 获取失败'), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
      }

      // 获取用户 UnionID
      const userRes = await fetch(
        `https://api.weixin.qq.com/sns/userinfo?access_token=${tokenData.access_token}&openid=${tokenData.openid}`
      );
      const userData = await userRes.json();
      const unionid = userData.unionid || tokenData.unionid || '';

      if (!unionid) {
        return new Response(LOGIN_PAGE('登录失败：无法获取 UnionID'), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
      }

      // 检查是否在允许列表
      const allowed = (env.ALLOWED_USERS || '').split(',').filter(Boolean);
      if (!allowed.includes(unionid)) {
        return new Response(LOGIN_PAGE('未获授权，请联系管理员'), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
      }

      // 认证成功，设置 cookie
      const nick = encodeURIComponent(userData.nickname || '');
      const headers = new Headers();
      headers.set('Set-Cookie', `${AUTH_COOKIE}=${unionid}:${nick}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; Secure`);
      headers.set('Location', '/');
      return new Response(null, { status: 302, headers });
    }

    // 发起微信 OAuth 登录
    if (url.pathname === '/auth/wechat') {
      const redirectUri = `${url.protocol}//${url.host}/auth/callback`;
      const oauthUrl = `https://open.weixin.qq.com/connect/qrconnect?appid=${env.WECHAT_APPID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_login&state=from_yue`;
      return new Response(null, { status: 302, headers: { Location: oauthUrl } });
    }

    // 检查已有认证
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(new RegExp(AUTH_COOKIE + '=([^:]+)'));
    const authed = match && match[1];
    const allowed = (env.ALLOWED_USERS || '').split(',').filter(Boolean);

    if (authed && allowed.includes(authed)) {
      // 已认证 → 正常返回应用
      return env.ASSETS.fetch(request);
    }

    // 未认证 → 显示登录页
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(LOGIN_PAGE(''), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }

    // 其他资源未认证 → 重定向到首页
    return new Response(null, { status: 302, headers: { Location: '/' } });
  },
};
