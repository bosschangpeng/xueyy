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

// ── 停顿标记 ──
function addSentencePauses(text) {
  text = text.replace(/([。！？.!?\n\r]+)/g, '$1<#0.5#>');
  text = text.replace(/([，、；：,;:]+)/g, '$1<#0.2#>');
  return text.replace(/<#[\d.]+#>$/, '');
}

// ── 构建「修改后文本位置 → 原文位置」映射 ──
// addSentencePauses 插入的 <#0.5#>/<#0.2#> 会让 MiniMax 字幕的 text_begin/text_end 偏移，
// 必须映射回原文位置，前端才能与 renderSentences 的 w.start/w.end 对齐。
function buildTextMapping(originalText, modifiedText) {
  const mapping = new Array(modifiedText.length);
  let oi = 0;
  for (let mi = 0; mi < modifiedText.length; mi++) {
    if (oi < originalText.length && modifiedText[mi] === originalText[oi]) {
      mapping[mi] = oi++;
    } else {
      mapping[mi] = -1;
    }
  }
  return mapping;
}

function parseWavHeader(hex) {
  const headerBytes = hexToBytes(hex.slice(0, 500));
  const dv = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  let _off = 12, pcmOff = 0, pcmSize = 0, wavSr = 32000, wavCh = 1, wavBits = 16;
  while (_off < headerBytes.length - 8) {
    const ck = String.fromCharCode(dv.getUint8(_off),dv.getUint8(_off+1),dv.getUint8(_off+2),dv.getUint8(_off+3));
    const sz = dv.getUint32(_off+4, true);
    if (ck === 'fmt ') { wavCh = dv.getUint16(_off+10, true); wavSr = dv.getUint32(_off+12, true); wavBits = dv.getUint16(_off+22, true) || 16; }
    else if (ck === 'data') { pcmOff = _off + 8; pcmSize = sz; }
    _off += 8 + sz;
  }
  return { pcmOff, pcmSize, wavSr, wavCh, wavBits };
}

async function buildCharTime(subtitle, textMapping) {
  const charTime = [];
  const items = Array.isArray(subtitle) ? subtitle : [];
  for (const item of items) {
    const twords = item.timestamped_words || [];
    if (!twords.length) continue;
    const totalChars = (item.text_end || 0) - (item.text_begin || 0);
    const totalTime = (item.time_end || 0) - (item.time_begin || 0);
    if (totalChars <= 0 || totalTime <= 0) continue;
    const sBegin = item.text_begin || 0;
    for (const w of twords) {
      const wBegin = w.word_begin - sBegin;
      const wEnd = w.word_end - sBegin;
      const wChars = wEnd - wBegin;
      if (wChars <= 0) continue;
      let wTimeBegin, wTimeEnd;
      if (w.time_begin != null && w.time_end != null) {
        wTimeBegin = w.time_begin; wTimeEnd = w.time_end;
      } else {
        wTimeBegin = item.time_begin + (wBegin / totalChars) * totalTime;
        wTimeEnd = item.time_begin + (wEnd / totalChars) * totalTime;
      }
      const wTime = wTimeEnd - wTimeBegin;
      if (wTime <= 0) continue;
      for (let ci = wBegin; ci < wEnd; ci++) {
        const modPos = sBegin + ci;
        const origPos = textMapping ? textMapping[modPos] : modPos;
        if (origPos == null || origPos < 0) continue;
        charTime[origPos] = [
          wTimeBegin + ((ci - wBegin) / wChars) * wTime,
          wTimeBegin + ((ci - wBegin + 1) / wChars) * wTime
        ];
      }
    }
  }
  const known = [];
  for (let i = 0; i < charTime.length; i++) if (charTime[i]) known.push(i);
  for (let k = 0; k < known.length - 1; k++) {
    const a = known[k], b = known[k + 1];
    if (b - a <= 1) continue;
    const total = charTime[b][0] - charTime[a][0], steps = b - a;
    for (let j = a + 1; j < b; j++)
      charTime[j] = [charTime[a][0] + ((j - a) / steps) * total, charTime[a][0] + ((j - a + 1) / steps) * total];
  }
  return charTime;
}

// ── 预处理：两份音频（原速句版 + 慢速词版） ──
async function preprocessTts(env, body) {
  const text = body.text || '';

  const sentenceText = addSentencePauses(text);
  const textMapping = buildTextMapping(text, sentenceText);

  const [sentData, wordData] = await Promise.all([
    minimaxTts(env, { text: sentenceText, voice: body.voice, speed: 1.0 }, { format: 'wav', subtitle_enable: true, subtitle_type: 'word' }),
    minimaxTts(env, { text: sentenceText, voice: body.voice, speed: 0.85 }, { format: 'wav', subtitle_enable: true, subtitle_type: 'word' }),
  ]);

  const sentHex = sentData.data?.audio || '';
  const wordHex = wordData.data?.audio || '';
  const sentWav = parseWavHeader(sentHex);
  const wordWav = parseWavHeader(wordHex);

  let sentSubtitle = null, wordSubtitle = null;
  if (sentData.data?.subtitle_file) {
    const r = await fetch(sentData.data.subtitle_file, { signal: AbortSignal.timeout(5000) });
    sentSubtitle = await r.json();
  }
  if (wordData.data?.subtitle_file) {
    const r = await fetch(wordData.data.subtitle_file, { signal: AbortSignal.timeout(5000) });
    wordSubtitle = await r.json();
  }

  const sentCharTime = await buildCharTime(sentSubtitle, textMapping);
  const wordCharTime = await buildCharTime(wordSubtitle, textMapping);

  return {
    sent_audio_hex: sentHex, word_audio_hex: wordHex,
    sent_char_time: sentCharTime, word_char_time: wordCharTime,
    sr: sentWav.wavSr, ch: sentWav.wavCh, bits: sentWav.wavBits,
    sent_off: sentWav.pcmOff, sent_size: sentWav.pcmSize,
    word_off: wordWav.pcmOff, word_size: wordWav.pcmSize,
    text,
  };
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
        const result = await preprocessTts(env, await request.json());
        return new Response(JSON.stringify(result), {
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
