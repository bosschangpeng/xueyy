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

async function minimaxTts(env, body, opts = {}) {
  const apiKey = env.MINIMAX_API_KEY || '';
  const groupId = env.MINIMAX_GROUP_ID || '';
  if (!apiKey || !groupId) {
    throw new Error('MiniMax not configured');
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
      audio_setting: {sample_rate:32000, bitrate:128000, format: opts.format||'mp3', channel:1},
      subtitle_enable: opts.subtitle_enable || false,
      subtitle_type: opts.subtitle_type,
    }),
  });
  if (!resp.ok) throw new Error('MiniMax API '+resp.status);
  const data = await resp.json();
  if (data.base_resp?.status_code !== 0) throw new Error(data.base_resp?.status_msg||'TTS error');
  return data;
}

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
}
function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
}

// ── 预处理：整句 TTS → 按前端分词切 PCM 直切 ──
async function preprocessTts(env, body) {
  const text = body.text || '';
  const wordPos = body.words || {}; // { "没": [0,1], "说": [1,2], ... }

  // 1. 调用 MiniMax
  const data = await minimaxTts(env, { text, voice: body.voice }, {
    format: 'pcm',
    subtitle_enable: true,
    subtitle_type: 'word',
  });

  const fullAudio = hexToBytes(data.data?.audio || '');
  const sr = data.extra_info?.audio_sample_rate || 32000;
  const channels = data.extra_info?.audio_channel || 1;
  const bytesPerMs = sr * channels * 2 / 1000; // 16-bit PCM

  // 2. 下载字幕
  let subtitle = null;
  if (data.data?.subtitle_file) {
    const subResp = await fetch(data.data.subtitle_file);
    subtitle = await subResp.json();
  }

  // 3. 构建字符→时间映射
  const charTime = [];
  const items = Array.isArray(subtitle) ? subtitle : [];
  for (const item of items) {
    const twords = item.timestamped_words || [];
    if (!twords.length) continue;
    const totalChars = (item.text_end || 0) - (item.text_begin || 0);
    const totalTime = (item.time_end || 0) - (item.time_begin || 0);
    const sBegin = item.text_begin || 0;
    if (totalChars <= 0 || totalTime <= 0) continue;

    for (const w of twords) {
      const wBegin = w.word_begin - sBegin;
      const wEnd = w.word_end - sBegin;
      for (let ci = wBegin; ci < wEnd; ci++) {
        const ratioS = ci / totalChars;
        const ratioE = (ci + 1) / totalChars;
        charTime[sBegin + ci] = {
          startMs: item.time_begin + ratioS * totalTime,
          endMs: item.time_begin + ratioE * totalTime,
        };
      }
    }
  }

  // 3.5 填补 charTime 空洞（线性插值）
  if (charTime.length > 0) {
    const known = [];
    for (let i = 0; i < charTime.length; i++) if (charTime[i]) known.push(i);
    for (let k = 0; k < known.length - 1; k++) {
      const a = known[k], b = known[k + 1];
      if (b - a <= 1) continue;
      const msA = charTime[a].startMs, msB = charTime[b].startMs;
      const total = msB - msA, steps = b - a;
      for (let j = a + 1; j < b; j++) {
        const t = (j - a) / steps;
        charTime[j] = {
          startMs: msA + t * total,
          endMs: msA + ((j - a + 1) / steps) * total,
        };
      }
    }
  }

  // 4. 按前端分词位置切片（PCM直切，无WAV头）
  const words = [];
  for (const [wtext, pos] of Object.entries(wordPos)) {
    const [cStart, cEnd] = pos;
    let startMs = null, endMs = null;
    for (let ci = cStart; ci < cEnd; ci++) {
      const ct = charTime[ci];
      if (ct) {
        if (startMs === null || ct.startMs < startMs) startMs = ct.startMs;
        if (endMs === null || ct.endMs > endMs) endMs = ct.endMs;
      }
    }
    if (startMs !== null && endMs !== null && endMs > startMs) {
      const startByte = Math.floor(startMs * bytesPerMs);
      const endByte = Math.ceil(endMs * bytesPerMs);
      if (startByte < fullAudio.length) {
        const pcm = fullAudio.slice(startByte, Math.min(endByte, fullAudio.length));
        if (pcm.length >= 100) {
          words.push({ text: wtext, pcm_hex: bytesToHex(pcm), sr, ch: channels, bits: 16 });
        }
      }
    }
  }
  return words;

  // 4. 构建字符→时间映射
  const charTime = [];
  const items = Array.isArray(subtitle) ? subtitle : [];
  for (const item of items) {
    const twords = item.timestamped_words || [];
    if (!twords.length) continue;
    const totalChars = (item.text_end || 0) - (item.text_begin || 0);
    const totalTime = (item.time_end || 0) - (item.time_begin || 0);
    const sBegin = item.text_begin || 0;
    if (totalChars <= 0 || totalTime <= 0) continue;

    for (const w of twords) {
      const wBegin = w.word_begin - sBegin;
      const wEnd = w.word_end - sBegin;
      for (let ci = wBegin; ci < wEnd; ci++) {
        const ratioS = ci / totalChars;
        const ratioE = (ci + 1) / totalChars;
        charTime[sBegin + ci] = {
          startMs: item.time_begin + ratioS * totalTime,
          endMs: item.time_begin + ratioE * totalTime,
        };
      }
    }
  }

  // 4.5 填补 charTime 空洞（线性插值）
  if (charTime.length > 0) {
    const known = [];
    for (let i = 0; i < charTime.length; i++) if (charTime[i]) known.push(i);
    for (let k = 0; k < known.length - 1; k++) {
      const a = known[k], b = known[k + 1];
      if (b - a <= 1) continue;
      const msA = charTime[a].startMs, msB = charTime[b].startMs;
      const total = msB - msA, steps = b - a;
      for (let j = a + 1; j < b; j++) {
        const t = (j - a) / steps;
        charTime[j] = {
          startMs: msA + t * total,
          endMs: msA + ((j - a + 1) / steps) * total,
        };
      }
    }
  }

  // 5. 按前端分词位置切片
  const words = [];
  for (const [wtext, pos] of Object.entries(wordPos)) {
    const [cStart, cEnd] = pos;
    let startMs = null, endMs = null;
    for (let ci = cStart; ci < cEnd; ci++) {
      const ct = charTime[ci];
      if (ct) {
        if (startMs === null || ct.startMs < startMs) startMs = ct.startMs;
        if (endMs === null || ct.endMs > endMs) endMs = ct.endMs;
      }
    }
    if (startMs !== null && endMs !== null && endMs > startMs) {
      const startByte = Math.floor(startMs * bytesPerMs);
      const endByte = Math.ceil(endMs * bytesPerMs);
      if (startByte < wavInfo.dataSize) {
        const samples = fullAudio.slice(dataOff + startByte, dataOff + Math.min(endByte, wavInfo.dataSize));
        if (samples.length < 100) continue;
        words.push({ text: wtext, audio_hex: bytesToHex(samples), pcm: true, sr: wavInfo.sampleRate, ch: wavInfo.channels, bits: wavInfo.bits });
      }
    }
  }
  return words;
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

    // 调试端点
    if (url.pathname === '/debug-tts') {
      const results = [];
      const apiKey = env.MINIMAX_API_KEY || '';
      const groupId = env.MINIMAX_GROUP_ID || '';
      results.push('Key: ' + (apiKey ? '已设('+apiKey.slice(0,6)+'...)' : '未设'));
      results.push('Group: ' + (groupId ? groupId : '未设'));
      if (!apiKey || !groupId) {
        return new Response(results.join(' | '), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
      }
      // 测试带字幕的请求
      try {
        const body = JSON.stringify({
          model: 'speech-2.8-hd', text: '你好世界', stream: false, language_boost: 'Chinese,Yue',
          voice_setting: {voice_id:'Cantonese_GentleLady', speed:1, vol:1, pitch:0},
          audio_setting: {sample_rate:32000, bitrate:128000, format:'wav', channel:1},
          subtitle_enable: true, subtitle_type: 'word',
        });
        const resp = await fetch('https://api.minimax.chat/v1/t2a_v2?GroupId=' + groupId, {
          method: 'POST', headers: {'Authorization':'Bearer '+apiKey,'Content-Type':'application/json'}, body,
        });
        const data = await resp.json();
        results.push('API: ' + (resp.ok && data.base_resp?.status_code === 0 ? 'OK' : 'FAIL:'+(data.base_resp?.status_msg||resp.status)));
        results.push('audio: ' + (data.data?.audio ? data.data.audio.length + 'chars(hex)' : 'NONE'));
        results.push('sub_file: ' + (data.data?.subtitle_file || 'NONE'));
        if (data.data?.subtitle_file) {
          const sr = await fetch(data.data.subtitle_file);
          const stxt = await sr.text();
          results.push('sub_raw: ' + stxt.slice(0, 500));
        }
      } catch (e) {
        results.push('ERR: ' + e.message);
      }
      return new Response(results.join(' | '), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    }

    // 预处理：整句 TTS → 切词
    if (url.pathname === '/preprocess' && request.method === 'POST') {
      if (!(await checkAuth(request, env))) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const words = await preprocessTts(env, await request.json());
        return new Response(JSON.stringify({ words, debug: { count: words.length } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({error:e.message}), {status:500,headers:{'Content-Type':'application/json'}});
      }
    }

    // MiniMax TTS 代理（单次请求，不再切分）
    if (url.pathname === '/tts') {
      if (request.method === 'HEAD') {
        return new Response(null, { status: (env.MINIMAX_API_KEY && env.MINIMAX_GROUP_ID) ? 200 : 500 });
      }
      if (request.method === 'POST') {
        if (!(await checkAuth(request, env))) {
          return new Response('Unauthorized', { status: 401 });
        }
        try {
          const data = await minimaxTts(env, await request.json());
          const audioHex = data.data?.audio || '';
          const audioBytes = hexToBytes(audioHex);
          return new Response(audioBytes, {
            headers: {'Content-Type':'audio/mpeg','Cache-Control':'public,max-age=31536000,immutable','Content-Length':String(audioBytes.length)},
          });
        } catch (e) {
          return new Response(JSON.stringify({error:e.message}), {status:500,headers:{'Content-Type':'application/json'}});
        }
      }
      return new Response('Method not allowed', { status: 405 });
    }

    if (await checkAuth(request, env)) {
      return env.ASSETS.fetch(request);
    }

    return new Response(PAGE(''), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
  },
};
