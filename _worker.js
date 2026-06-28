// 粤语学习助手 — 密码 + 邀请码双验证 + CosyVoice TTS代理
// ACCESS_PWD = 管理员密码（永久有效，不消耗）
// ALLOWED_CODES = 邀请码列表（一人一码，KV自动标记已用）
// DASHSCOPE_API_KEY = 阿里云百炼 DashScope API Key
// COSYVOICE_MODEL = 可选，默认 cosyvoice-v3-flash
// COSYVOICE_VOICE = 可选，默认 longanhuan_v3
// KV绑定变量名 YUE_KV

const AUTH_COOKIE = 'yue_token';
const COOKIE_DAYS = 3650;
const TTS_RPM_LIMIT = 60;
const TTS_REQUEST_INTERVAL_MS = Math.ceil(60000 / TTS_RPM_LIMIT) + 100;
const TTS_RATE_LIMIT_RETRY_MS = 65000;
let ttsNextRequestAt = 0;
let ttsQueue = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTtsSlot(label = 'tts') {
  const previous = ttsQueue.catch(() => {});
  let release;
  ttsQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    const waitMs = Math.max(0, ttsNextRequestAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    ttsNextRequestAt = Date.now() + TTS_REQUEST_INTERVAL_MS;
  } finally {
    release();
  }
}

function ttsProviderError(message, status = 500, retryAfter = '') {
  const err = new Error(message);
  err.status = status;
  if (retryAfter) err.retryAfter = retryAfter;
  return err;
}

function ttsJsonError(e) {
  const status = Number(e.status) || 500;
  const headers = {'Content-Type':'application/json'};
  if (status === 429) headers['Retry-After'] = e.retryAfter || String(Math.ceil(TTS_RATE_LIMIT_RETRY_MS / 1000));
  return new Response(JSON.stringify({error:e.message}), {status, headers});
}

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

function decodeAudioPayload(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const dataUrl = raw.match(/^data:[^,]+,(.*)$/i);
  const payload = dataUrl ? dataUrl[1] : raw;
  if (/^[0-9a-f]+$/i.test(payload) && payload.length % 2 === 0 && payload.length > 64) {
    return hexToBytes(payload);
  }
  try {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function getCosyAudioCandidates(data) {
  const out = data?.output || {};
  const audio = out.audio || {};
  const urls = [audio.url, audio.audio_url, out.audio_url, out.url, typeof audio === 'string' && /^https?:/i.test(audio) ? audio : ''].filter(Boolean);
  const payloads = [audio.data, audio.hex, audio.audio, out.data, out.audio_data, typeof audio === 'string' && !/^https?:/i.test(audio) ? audio : ''].filter(Boolean);
  return { audio, urls: [...new Set(urls)], payloads };
}
function getAudioDebug(bytes) {
  const head = Array.from(bytes || []).slice(0, 16);
  return {
    bytes: bytes?.length || 0,
    hex: head.map(b => b.toString(16).padStart(2, '0')).join(' '),
    ascii: head.map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join(''),
  };
}

function validateAudioBytes(bytes, format) {
  const info = getAudioDebug(bytes);
  const fmt = String(format || '').toLowerCase();
  if (!bytes || bytes.length < 512) throw ttsProviderError(`CosyVoice returned invalid audio: too small ${JSON.stringify(info)}`, 502);
  if (bytes[0] === 60 || bytes[0] === 123) throw ttsProviderError(`CosyVoice returned invalid audio payload: ${JSON.stringify(info)}`, 502);
  if (fmt === 'wav') {
    const ok = bytes.length > 44 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70;
    if (!ok) throw ttsProviderError(`CosyVoice returned invalid wav: ${JSON.stringify(info)}`, 502);
  }
  if (fmt === 'mp3') {
    const hasId3 = bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51;
    const hasFrame = bytes[0] === 255 && (bytes[1] & 224) === 224;
    if (bytes.length < 2400 || (!hasId3 && !hasFrame)) throw ttsProviderError(`CosyVoice returned invalid mp3: ${JSON.stringify(info)}`, 502);
  }
  return info;
}

function normalizeCosyText(text) {
  const raw = String(text || '').trim();
  if (/^[\u3400-\u9fff]$/u.test(raw)) return raw + '。';
  return raw;
}


async function fetchCosyAudioUrl(url, apiKey) {
  const delays = [0, 450, 1200, 2500];
  let lastStatus = 0;
  let lastDetail = '';
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    const resp = await fetch(url, {
      headers: {
        'Accept': 'audio/*,*/*',
        'Authorization': 'Bearer ' + apiKey,
        'User-Agent': 'xueyy-cosyvoice-worker/1.0',
      },
      redirect: 'follow',
    });
    if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
    lastStatus = resp.status;
    try { lastDetail = (await resp.clone().text()).slice(0, 180); } catch {}
    if (resp.status !== 404) break;
  }
  let host = '';
  try { host = new URL(url).host; } catch {}
  throw ttsProviderError(`CosyVoice audio url fetch failed: ${lastStatus}${host ? ' host=' + host : ''}${lastDetail ? ' body=' + lastDetail : ''}`, lastStatus || 500);
}

async function cosyVoiceTts(env, body, opts = {}) {
  const apiKey = env.DASHSCOPE_API_KEY || env.COSYVOICE_API_KEY || env.ALIYUN_API_KEY || '';
  if (!apiKey) throw new Error('CosyVoice not configured: missing DASHSCOPE_API_KEY');
  await waitForTtsSlot('cosyVoiceTts');

  const audioFormat = opts.format || body.format || 'wav';
  const model = body.model || opts.model || env.COSYVOICE_MODEL || 'cosyvoice-v3-flash';
  const voice = body.voice || opts.voice || env.COSYVOICE_VOICE || 'longanhuan_v3';
  const rate = Number(body.rate ?? body.speed ?? opts.rate ?? 1.0);
  const sampleRate = Number(body.sample_rate || opts.sample_rate || 24000);
  const instruction = body.instruction || opts.instruction || env.COSYVOICE_INSTRUCTION || (voice === 'longanhuan_v3' ? '请用广东话表达。' : '');

  const input = {
    text: normalizeCosyText(body.text),
    voice,
    format: audioFormat,
    sample_rate: sampleRate,
    volume: Number(body.volume ?? opts.volume ?? 50),
    rate: Number.isFinite(rate) ? Math.max(0.5, Math.min(2.0, rate)) : 1.0,
    pitch: Number(body.pitch ?? opts.pitch ?? 1.0),
    language_hints: body.language_hints || opts.language_hints || ['zh'],
    enable_aigc_tag: body.enable_aigc_tag ?? opts.enable_aigc_tag ?? false,
  };
  if (instruction) input.instruction = instruction;
  if (body.hot_fix || opts.hot_fix) input.hot_fix = body.hot_fix || opts.hot_fix;
  if (body.enable_ssml || opts.enable_ssml) input.enable_ssml = true;

  const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  if (!resp.ok) {
    let msg = 'CosyVoice API ' + resp.status;
    try {
      const errData = await resp.clone().json();
      msg = errData.message || errData.code || errData.error || msg;
    } catch {
      try { const txt = await resp.text(); if (txt) msg = msg + ': ' + txt.slice(0, 200); } catch {}
    }
    throw ttsProviderError(msg, resp.status, resp.headers.get('Retry-After') || '');
  }
  const data = await resp.json();
  const candidates = getCosyAudioCandidates(data);
  let bytes = null;
  for (const payload of candidates.payloads) {
    bytes = decodeAudioPayload(payload);
    if (bytes && bytes.length) break;
  }
  if ((!bytes || !bytes.length) && candidates.urls.length) {
    try {
      bytes = await fetchCosyAudioUrl(candidates.urls[0], apiKey);
    } catch (e) {
      if (Number(e.status) === 404 && !opts.__retryBadUrl) {
        await sleep(800);
        return await cosyVoiceTts(env, body, { ...opts, __retryBadUrl: true });
      }
      if (Number(e.status) === 404 && audioFormat !== 'mp3' && !opts.__retryMp3Fallback) {
        await sleep(800);
        return await cosyVoiceTts(env, { ...body, format: 'mp3' }, { ...opts, format: 'mp3', __retryBadUrl: true, __retryMp3Fallback: true });
      }
      throw e;
    }
  }
  if (!bytes || !bytes.length) {
    const outputKeys = Object.keys(data.output || {}).join(',') || 'none';
    const audioKeys = candidates.audio && typeof candidates.audio === 'object' ? Object.keys(candidates.audio).join(',') : typeof candidates.audio;
    throw ttsProviderError(`CosyVoice returned empty audio: outputKeys=${outputKeys}; audioKeys=${audioKeys || 'none'}`, 500);
  }
  const audioDebug = validateAudioBytes(bytes, audioFormat);
  return { data, bytes, format: audioFormat, model, voice, sampleRate, provider: 'cosyvoice', requestText: input.text, audioDebug };
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

function buildSpeechText(originalText) {
  const sentencePause = '<#0.55#>';
  const commaPause = '<#0.18#>';
  const chars = Array.from(originalText || '');
  const out = [];
  const mapToOriginal = [];
  let lastInsertedPause = false;

  function append(s, origIndex) {
    for (const ch of Array.from(s)) {
      out.push(ch);
      mapToOriginal.push(origIndex);
    }
  }

  function appendPause(mark) {
    if (lastInsertedPause) return;
    append(mark, -1);
    lastInsertedPause = true;
  }

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    append(ch, i);

    if (/[\r\n]/u.test(ch)) {
      appendPause(sentencePause);
      continue;
    }
    if (/[。！？!?]/u.test(ch)) {
      appendPause(sentencePause);
      continue;
    }
    if (/[，、；;：:]/u.test(ch)) {
      appendPause(commaPause);
      continue;
    }

    if (!/\s/u.test(ch)) lastInsertedPause = false;
  }

  while (out.length && mapToOriginal[mapToOriginal.length - 1] < 0) {
    out.pop();
    mapToOriginal.pop();
  }

  return { text: out.join(''), mapToOriginal };
}

function projectCharTimeToOriginal(speechCharTime, mapToOriginal, originalLength, audioDurationMs) {
  const charTime = new Array(originalLength);
  for (let i = 0; i < speechCharTime.length; i++) {
    const orig = mapToOriginal[i];
    if (orig == null || orig < 0 || orig >= originalLength || !speechCharTime[i]) continue;
    const cur = charTime[orig];
    if (!cur) {
      charTime[orig] = speechCharTime[i];
    } else {
      charTime[orig] = [
        Math.min(cur[0], speechCharTime[i][0]),
        Math.max(cur[1], speechCharTime[i][1])
      ];
    }
  }
  fillCharTimeGaps(charTime, audioDurationMs);
  return charTime;
}

// ── 构建「修改后文本位置 → 原文位置」映射 ──
// addSentencePauses 是旧字幕对齐流程遗留函数；CosyVoice HTTP 模式下不再使用字幕裁切。
// 必须映射回原文位置，前端才能与 renderSentences 的 w.start/w.end 对齐。
function buildTextMapping(originalText, modifiedText) {
  const mapping = new Array(modifiedText.length).fill(-1);
  // 先标记所有停顿标记位置（<#0.5#> 等）
  const markerRe = /<#[\d.]+#>/g;
  const markerSet = new Set();
  let m;
  while ((m = markerRe.exec(modifiedText)) !== null) {
    for (let i = m.index; i < m.index + m[0].length; i++) markerSet.add(i);
  }
  // 双指针：仅在非标记位置做原文匹配
  let oi = 0;
  for (let mi = 0; mi < modifiedText.length; mi++) {
    if (markerSet.has(mi)) continue;
    if (oi < originalText.length && modifiedText[mi] === originalText[oi]) {
      mapping[mi] = oi++;
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

function buildTextIndex(text) {
  const chars = Array.from(text || '');
  const utf16ToCp = new Array((text || '').length + 1);
  let utf16 = 0;
  utf16ToCp[0] = 0;
  for (let i = 0; i < chars.length; i++) {
    for (let j = 0; j < chars[i].length; j++) utf16ToCp[utf16 + j] = i;
    utf16 += chars[i].length;
    utf16ToCp[utf16] = i + 1;
  }
  for (let i = 1; i < utf16ToCp.length; i++) if (utf16ToCp[i] == null) utf16ToCp[i] = utf16ToCp[i - 1];

  const utf8ToCp = [0];
  const enc = new TextEncoder();
  let byteOff = 0;
  for (let i = 0; i < chars.length; i++) {
    const n = enc.encode(chars[i]).length;
    for (let j = 0; j < n; j++) utf8ToCp[byteOff + j] = i;
    byteOff += n;
    utf8ToCp[byteOff] = i + 1;
  }
  for (let i = 1; i < utf8ToCp.length; i++) if (utf8ToCp[i] == null) utf8ToCp[i] = utf8ToCp[i - 1];

  const markerCp = new Set();
  const markerRe = /<#[\d.]+#>/g;
  let marker;
  while ((marker = markerRe.exec(text || '')) !== null) {
    const start = utf16ToCp[marker.index] ?? 0;
    const end = utf16ToCp[marker.index + marker[0].length] ?? start;
    for (let i = start; i < end; i++) markerCp.add(i);
  }

  const searchChars = [];
  const searchMap = [];
  for (let i = 0; i < chars.length; i++) {
    if (markerCp.has(i) || /\s/u.test(chars[i])) continue;
    searchChars.push(chars[i].toLowerCase());
    searchMap.push(i);
  }
  return { text: text || '', chars, utf16ToCp, utf8ToCp, searchText: searchChars.join(''), searchMap };
}

function compactText(s) {
  return Array.from(String(s || '').replace(/<#[\d.]+#>/g, '')).filter(ch => !/\s/u.test(ch)).join('').toLowerCase();
}

function scoreTextMatch(piece, expected) {
  const a = String(piece || '');
  const b = String(expected || '');
  if (!b) return 0;
  if (a === b) return 8;
  if (a.trim() === b.trim()) return 7;
  const ca = compactText(a);
  const cb = compactText(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 6;
  if (ca.includes(cb) || cb.includes(ca)) return 3;
  return 0;
}

function cpSlice(idx, begin, end) {
  return idx.chars.slice(begin, end).join('');
}

function rangeFromUnit(idx, begin, end, unit) {
  if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin) return null;
  begin = Math.trunc(begin);
  end = Math.trunc(end);
  if (unit === 'cp') {
    if (begin < 0 || end > idx.chars.length) return null;
    return { start: begin, end };
  }
  const map = unit === 'utf8' ? idx.utf8ToCp : idx.utf16ToCp;
  if (begin < 0 || end >= map.length) return null;
  const start = map[begin];
  const outEnd = map[end];
  if (start == null || outEnd == null || outEnd <= start) return null;
  return { start, end: outEnd };
}

function offsetCandidates(idx, begin, end, expected, source) {
  const out = [];
  for (const unit of ['cp', 'utf16', 'utf8']) {
    const range = rangeFromUnit(idx, begin, end, unit);
    if (!range) continue;
    const score = scoreTextMatch(cpSlice(idx, range.start, range.end), expected);
    if (score >= 3) out.push({ ...range, score, source: source + ':' + unit });
  }
  return out;
}

function lowerSearchPos(idx, cp) {
  let lo = 0, hi = idx.searchMap.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (idx.searchMap[mid] < cp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function findTextRange(idx, expected, minCp) {
  const needle = compactText(expected);
  if (!needle) return null;
  const pos = idx.searchText.indexOf(needle, lowerSearchPos(idx, minCp || 0));
  if (pos < 0) return null;
  const start = idx.searchMap[pos];
  const end = idx.searchMap[pos + needle.length - 1] + 1;
  return { start, end, score: 4, source: 'search' };
}

function bestItemRange(idx, item, cursor) {
  const expected = item.text || '';
  let candidates = [];
  if (item.text_begin != null && item.text_end != null) {
    candidates = candidates.concat(offsetCandidates(idx, item.text_begin, item.text_end, expected, 'item'));
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) return candidates[0];
  return findTextRange(idx, expected, cursor || 0);
}

function bestWordRange(idx, itemIdx, itemRange, word, cursor) {
  const expected = word.word || '';
  let candidates = [];
  if (word.word_begin != null && word.word_end != null) {
    candidates = candidates.concat(offsetCandidates(idx, word.word_begin, word.word_end, expected, 'word'));
    if (itemIdx && itemRange) {
      for (const c of offsetCandidates(itemIdx, word.word_begin, word.word_end, expected, 'word_rel_item')) {
        candidates.push({
          start: itemRange.start + c.start,
          end: itemRange.start + c.end,
          score: c.score,
          source: c.source
        });
      }
    }
  }
  if (itemRange) {
    for (const c of candidates) {
      if (c.start >= itemRange.start && c.end <= itemRange.end) c.score += 2;
      else if (c.end <= itemRange.start || c.start >= itemRange.end) c.score -= 3;
    }
  }
  candidates = candidates.filter(c => c.score >= 3 && c.end > c.start);
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) return candidates[0];
  return findTextRange(idx, expected, Math.max(cursor || 0, itemRange?.start || 0));
}

function applyTimedRange(charTime, sources, groups, range, timeBegin, timeEnd, sourceLabel, groupId) {
  if (!range || !Number.isFinite(timeBegin) || !Number.isFinite(timeEnd) || timeEnd <= timeBegin) return 0;
  const start = Math.max(0, range.start);
  const end = Math.min(charTime.length, range.end);
  const span = end - start;
  if (span <= 0) return 0;
  const dur = timeEnd - timeBegin;
  let n = 0;
  for (let i = start; i < end; i++) {
    charTime[i] = [
      timeBegin + ((i - start) / span) * dur,
      timeBegin + ((i - start + 1) / span) * dur
    ];
    if (sources) sources[i] = sourceLabel || 'word';
    if (groups) groups[i] = groupId || sourceLabel || 'word';
    n++;
  }
  return n;
}

function fillCharTimeGaps(charTime, audioDurationMs, sources) {
  const known = [];
  for (let i = 0; i < charTime.length; i++) if (charTime[i]) known.push(i);
  if (!known.length) return;

  const first = known[0];
  if (first > 0 && charTime[first][0] > 0) {
    const dur = charTime[first][0];
    for (let i = 0; i < first; i++) {
      charTime[i] = [(i / first) * dur, ((i + 1) / first) * dur];
      if (sources) sources[i] = 'lead';
    }
  }

  for (let k = 0; k < known.length - 1; k++) {
    const a = known[k], b = known[k + 1];
    if (b - a <= 1) continue;
    const begin = charTime[a][1];
    const end = charTime[b][0];
    if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin) continue;
    const steps = b - a;
    for (let i = a + 1; i < b; i++) {
      charTime[i] = [
        begin + ((i - a - 1) / steps) * (end - begin),
        begin + ((i - a) / steps) * (end - begin)
      ];
      if (sources) sources[i] = 'gap';
    }
  }

  const last = known[known.length - 1];
  if (audioDurationMs && last < charTime.length - 1 && audioDurationMs > charTime[last][1]) {
    const begin = charTime[last][1];
    const tail = charTime.length - 1 - last;
    for (let i = last + 1; i < charTime.length; i++) {
      charTime[i] = [
        begin + ((i - last - 1) / tail) * (audioDurationMs - begin),
        begin + ((i - last) / tail) * (audioDurationMs - begin)
      ];
      if (sources) sources[i] = 'tail';
    }
  }
}

async function buildCharTime(subtitle, text, audioDurationMs) {
  const idx = buildTextIndex(text);
  const charTime = new Array(idx.chars.length);
  const sources = new Array(idx.chars.length);
  const groups = new Array(idx.chars.length);
  const items = Array.isArray(subtitle) ? subtitle : [];
  let cursor = 0;

  for (let itemNo = 0; itemNo < items.length; itemNo++) {
    const item = items[itemNo];
    const itemRange = bestItemRange(idx, item, cursor);
    const itemIdx = item.text ? buildTextIndex(item.text) : null;
    const twords = Array.isArray(item.timestamped_words) ? item.timestamped_words : [];
    let addedWords = 0;

    for (let wordNo = 0; wordNo < twords.length; wordNo++) {
      const w = twords[wordNo];
      const range = bestWordRange(idx, itemIdx, itemRange, w, cursor);
      if (!range) continue;
      let tb = w.time_begin;
      let te = w.time_end;
      if ((tb == null || te == null || te <= tb) && itemRange && item.time_begin != null && item.time_end != null) {
        const itemSpan = Math.max(1, itemRange.end - itemRange.start);
        tb = item.time_begin + ((range.start - itemRange.start) / itemSpan) * (item.time_end - item.time_begin);
        te = item.time_begin + ((range.end - itemRange.start) / itemSpan) * (item.time_end - item.time_begin);
      }
      const hasDirectWordTime = w.time_begin != null && w.time_end != null && w.time_end > w.time_begin;
      const sourceLabel = hasDirectWordTime
        ? (range.end - range.start === 1 ? 'char' : 'word')
        : 'word_est';
      const groupId = `${sourceLabel}:${itemNo}:${wordNo}:${range.start}-${range.end}`;
      if (applyTimedRange(charTime, sources, groups, range, tb, te, sourceLabel, groupId)) {
        addedWords++;
        cursor = Math.max(cursor, range.end);
      }
    }

    if (!addedWords && itemRange && item.time_begin != null && item.time_end != null) {
      applyTimedRange(charTime, sources, groups, itemRange, item.time_begin, item.time_end, 'item', `item:${itemNo}:${itemRange.start}-${itemRange.end}`);
      cursor = Math.max(cursor, itemRange.end);
    }
  }

  fillCharTimeGaps(charTime, audioDurationMs, sources);
  return { charTime, sources, groups };
}

function summarizeSubtitle(subtitle) {
  const items = Array.isArray(subtitle) ? subtitle : [];
  return items.slice(0, 20).map((item, idx) => ({
    idx,
    text: String(item.text || '').slice(0, 120),
    text_begin: item.text_begin,
    text_end: item.text_end,
    time_begin: item.time_begin,
    time_end: item.time_end,
    words: (Array.isArray(item.timestamped_words) ? item.timestamped_words : []).slice(0, 80).map((w, wi) => ({
      wi,
      word: String(w.word || '').slice(0, 40),
      word_begin: w.word_begin,
      word_end: w.word_end,
      time_begin: w.time_begin,
      time_end: w.time_end,
    }))
  }));
}

// ── 预处理：直接合成当前句/片段，停顿由前端拼接真实静音 ──

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}
function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

async function preprocessTts(env, body) {
  throw ttsProviderError('CosyVoice HTTP 当前不提供非流式字级时间轴，预处理裁切流程已停用', 501);
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
      const apiKey = env.DASHSCOPE_API_KEY || env.COSYVOICE_API_KEY || env.ALIYUN_API_KEY || '';
      results.push('Provider: CosyVoice');
      results.push('Key: ' + (apiKey ? '已设('+apiKey.slice(0,6)+'...)' : '未设'));
      if (!apiKey) {
        return new Response(results.join(' | '), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
      }
      // 测试 CosyVoice 请求
      try {
        const out = await cosyVoiceTts(env, { text: '你好世界', voice: env.COSYVOICE_VOICE || 'longanhuan_v3', format: 'wav', sample_rate: 24000, instruction: env.COSYVOICE_INSTRUCTION || '请用广东话表达。' });
        results.push('API: OK');
        results.push('audio: ' + out.bytes.length + ' bytes');
        results.push('model: ' + out.model);
        results.push('voice: ' + out.voice);
      } catch (e) {
        results.push('ERR: ' + e.message);
      }
      return new Response(results.join(' | '), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    }


    if (url.pathname === '/debug-pronunciation') {
      if (!(await checkAuth(request, env))) {
        return new Response('Unauthorized', { status: 401 });
      }
      const text = url.searchParams.get('text') || '说';
      const py = url.searchParams.get('py') || 'shuo1';
      const jp = url.searchParams.get('jp') || 'syut3';
      const instruction = env.COSYVOICE_INSTRUCTION || '请用广东话表达。';
      const variants = [
        { id: 'plain', label: '不指定读音', body: { text } },
        { id: 'pinyin', label: `普通话拼音 hot_fix: ${py}`, body: { text, hot_fix: { pronunciation: [ { [text]: py } ] } } },
        { id: 'jyutping', label: `粤拼 hot_fix: ${jp}`, body: { text, hot_fix: { pronunciation: [ { [text]: jp } ] } } },
      ];
      const rows = [];
      for (const v of variants) {
        try {
          const out = await cosyVoiceTts(env, {
            ...v.body,
            voice: env.COSYVOICE_VOICE || 'longanhuan_v3',
            model: env.COSYVOICE_MODEL || 'cosyvoice-v3-flash',
            format: 'wav',
            sample_rate: 24000,
            instruction,
          });
          let bin = '';
          for (const b of out.bytes) bin += String.fromCharCode(b);
          const b64 = btoa(bin);
          const mime = out.format === 'mp3' ? 'audio/mpeg' : (out.format === 'opus' ? 'audio/ogg' : 'audio/wav');
          rows.push(`<section><h3>${escapeHtml(v.label)}</h3><audio controls src="data:${mime};base64,${b64}"></audio><pre>${escapeHtml(JSON.stringify({ text, request: v.body, sentText: out.requestText, bytes: out.bytes.length, format: out.format, audioDebug: out.audioDebug, model: out.model, voice: out.voice }, null, 2))}</pre></section>`);
        } catch (e) {
          rows.push(`<section><h3>${escapeHtml(v.label)}</h3><pre class="err">${escapeHtml(JSON.stringify({ error: e.message, request: v.body }, null, 2))}</pre></section>`);
        }
      }
      const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CosyVoice 发音实测</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:880px;margin:28px auto;padding:0 16px;line-height:1.55;color:#1f2d3d}section{border:1px solid #dde4ef;border-radius:8px;padding:16px;margin:14px 0;background:#fff}audio{width:100%;margin:8px 0}pre{white-space:pre-wrap;background:#f6f8fb;padding:12px;border-radius:6px;overflow:auto}.err{color:#b42318;background:#fff1f0}input{padding:8px 10px;margin:0 8px 8px 0;border:1px solid #cfd8e3;border-radius:6px}button{padding:8px 12px;border:0;border-radius:6px;background:#3778c2;color:#fff}</style><h1>CosyVoice 发音实测</h1><form method="get"><input name="text" value="${escapeAttr(text)}" placeholder="字/词"><input name="py" value="${escapeAttr(py)}" placeholder="普通话拼音"><input name="jp" value="${escapeAttr(jp)}" placeholder="粤拼"><button>生成</button></form><p>目标：听 CosyVoice 的 <code>hot_fix.pronunciation</code> 是否接受粤拼，还是只接受普通话拼音。</p>${rows.join('')}`;
      return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } });
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
        return ttsJsonError(e);
      }
    }

    // CosyVoice TTS 代理（单次请求，不再切分）
    if (url.pathname === '/tts') {
      if (request.method === 'HEAD') {
        return new Response(null, { status: (env.DASHSCOPE_API_KEY || env.COSYVOICE_API_KEY || env.ALIYUN_API_KEY) ? 200 : 500 });
      }
      if (request.method === 'GET' || request.method === 'POST') {
        if (!(await checkAuth(request, env))) {
          return new Response('Unauthorized', { status: 401 });
        }
        try {
          const body = request.method === 'POST'
            ? await request.json()
            : { text: url.searchParams.get('text') || '', voice: url.searchParams.get('voice') || undefined, speed: Number(url.searchParams.get('speed') || 1) };
          const out = await cosyVoiceTts(env, body);
          const audioFormat = out.format || body.format || 'wav';
          const contentType = audioFormat === 'wav' ? 'audio/wav' : (audioFormat === 'pcm' ? 'audio/L16' : (audioFormat === 'opus' ? 'audio/ogg' : 'audio/mpeg'));
          return new Response(out.bytes, {
            headers: {
              'Content-Type': contentType,
              'Cache-Control': 'public,max-age=31536000,immutable',
              'Content-Length': String(out.bytes.length),
              'X-Audio-Format': audioFormat,
              'X-TTS-Provider': 'cosyvoice',
              'X-TTS-Model': out.model,
              'X-TTS-Voice': out.voice,
            },
          });
        } catch (e) {
          return ttsJsonError(e);
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
