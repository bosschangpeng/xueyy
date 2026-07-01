// 粤语学习助手 — 密码 + 邀请码双验证 + Qwen TTS代理
// ACCESS_PWD = 管理员密码（永久有效，不消耗）
// ALLOWED_CODES = 邀请码列表（一人一码，KV自动标记已用）
// DASHSCOPE_API_KEY = 阿里云百炼 DashScope API Key
// QWEN_TTS_MODEL = optional, defaults to qwen3-tts-flash
// QWEN_TTS_VOICE = optional, defaults to Rocky
// KV绑定变量名 YUE_KV

const AUTH_COOKIE = 'yue_token';
const COOKIE_DAYS = 3650;
const TTS_RPM_LIMIT = 60;
const TTS_REQUEST_INTERVAL_MS = Math.ceil(60000 / TTS_RPM_LIMIT) + 100;
const TTS_RATE_LIMIT_RETRY_MS = 65000;
let ttsNextRequestAt = 0;
let ttsQueue = Promise.resolve();
const QWEN_TTS_DEFAULT_MODEL = 'qwen3-tts-flash';
const QWEN_TTS_DEFAULT_VOICE = 'Rocky';

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

function defaultCosyInstruction(env, voice) {
  if (voice === 'longanhuan_v3') return env.COSYVOICE_INSTRUCTION || '\u8bf7\u7528\u5e7f\u4e1c\u8bdd\u8868\u8fbe\u3002';
  return '';
}

function defaultCosyVolume(_voice) {
  return 50;
}

function defaultCosyPitch(_voice) {
  return 1.0;
}

function defaultCosyPreprocessSpeed(_voice) {
  return 0.85;
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

function concatByteChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function audioPayloadsFromData(data) {
  const out = data?.output || {};
  const audio = out.audio || {};
  return [
    audio.data,
    audio.hex,
    audio.audio,
    out.data,
    out.audio_data,
    typeof audio === 'string' && !/^https?:/i.test(audio) ? audio : '',
  ].filter(Boolean);
}

function collectCosyAudioFromJsonPayload(payload, state) {
  const raw = String(payload || '').trim();
  if (!raw || raw === '[DONE]') return;
  let data = null;
  try { data = JSON.parse(raw); } catch { return; }
  state.lastData = data;
  for (const audioPayload of audioPayloadsFromData(data)) {
    const bytes = decodeAudioPayload(audioPayload);
    if (bytes && bytes.length) state.chunks.push(bytes);
  }
}
function cosySseDataPayloadFromLine(line) {
  const idx = String(line || '').indexOf('data:');
  return idx >= 0 ? String(line).slice(idx + 5).trimStart() : '';
}

function parseCosySseAudio(text) {
  const source = String(text || '');
  const state = { chunks: [], lastData: null };
  const events = source.split(/\r?\n\r?\n/);
  for (const event of events) {
    const dataLines = [];
    for (const line of event.split(/\r?\n/)) {
      const payload = cosySseDataPayloadFromLine(line);
      if (payload) dataLines.push(payload);
    }
    if (dataLines.length === 1) {
      collectCosyAudioFromJsonPayload(dataLines[0], state);
    } else if (dataLines.length > 1) {
      collectCosyAudioFromJsonPayload(dataLines.join('\n'), state);
      if (!state.chunks.length) {
        for (const line of dataLines) collectCosyAudioFromJsonPayload(line, state);
      }
    }
  }
  if (!state.chunks.length) {
    for (const line of source.split(/\r?\n/)) {
      const payload = cosySseDataPayloadFromLine(line);
      if (payload) collectCosyAudioFromJsonPayload(payload, state);
    }
  }
  return { data: state.lastData || {}, bytes: concatByteChunks(state.chunks), chunks: state.chunks.length };
}

function getAudioDebug(bytes) {
  const head = Array.from(bytes || []).slice(0, 16);
  const info = {
    bytes: bytes?.length || 0,
    hex: head.map(b => b.toString(16).padStart(2, '0')).join(' '),
    ascii: head.map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join(''),
  };
  const wav = bytes?.length ? parseWavInfo(bytes) : null;
  if (wav) {
    info.wav = {
      audioFormat: wav.audioFormat,
      channels: wav.channels,
      sampleRate: wav.sampleRate,
      bitsPerSample: wav.bitsPerSample,
      blockAlign: wav.blockAlign,
      dataOffset: wav.dataOffset,
      dataSize: wav.dataSize,
      declaredDataSize: wav.declaredDataSize,
      riffSize: wav.riffSize,
      durationMs: Math.round(wav.dataSize / (wav.sampleRate * wav.blockAlign / 1000)),
    };
  }
  return info;
}

function validateAudioBytes(bytes, format, provider = 'TTS') {
  const info = getAudioDebug(bytes);
  const fmt = String(format || '').toLowerCase();
  if (!bytes || bytes.length < 512) throw ttsProviderError(`${provider} returned invalid audio: too small ${JSON.stringify(info)}`, 502);
  if (bytes[0] === 60 || bytes[0] === 123) throw ttsProviderError(`${provider} returned invalid audio payload: ${JSON.stringify(info)}`, 502);
  if (fmt === 'wav') {
    const ok = bytes.length > 44 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70;
    if (!ok) throw ttsProviderError(`${provider} returned invalid wav: ${JSON.stringify(info)}`, 502);
  }
  if (fmt === 'mp3') {
    const hasId3 = bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51;
    const hasFrame = bytes[0] === 255 && (bytes[1] & 224) === 224;
    if (bytes.length < 2400 || (!hasId3 && !hasFrame)) throw ttsProviderError(`${provider} returned invalid mp3: ${JSON.stringify(info)}`, 502);
  }
  return info;
}
function readAscii(bytes, offset, len) {
  return String.fromCharCode(...bytes.slice(offset, offset + len));
}

function parseWavInfo(bytes) {
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  const info = { audioFormat: 0, channels: 0, sampleRate: 0, bitsPerSample: 0, blockAlign: 0, dataOffset: 0, dataSize: 0, declaredDataSize: 0, riffSize: view.getUint32(4, true) };
  while (pos + 8 <= bytes.length) {
    const id = readAscii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const dataPos = pos + 8;
    if (id === 'fmt ') {
      info.audioFormat = view.getUint16(dataPos, true);
      info.channels = view.getUint16(dataPos + 2, true);
      info.sampleRate = view.getUint32(dataPos + 4, true);
      info.blockAlign = view.getUint16(dataPos + 12, true);
      info.bitsPerSample = view.getUint16(dataPos + 14, true);
    } else if (id === 'data') {
      info.dataOffset = dataPos;
      info.declaredDataSize = size;
      info.dataSize = size;
    }
    pos = dataPos + size + (size % 2);
  }
  if (!info.dataOffset || !info.dataSize || info.audioFormat !== 1 || !info.blockAlign) return null;
  info.dataSize = Math.min(info.dataSize, bytes.length - info.dataOffset);
  return info;
}

function makePcmWav(pcm, sampleRate, channels, bitsPerSample) {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true);
  view.setUint16(32, channels * bitsPerSample / 8, true);
  view.setUint16(34, bitsPerSample, true);
  write(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

function cropWavByMs(bytes, startMs, endMs, padStartMs = 25, padEndMs = 80, opts = {}) {
  const info = parseWavInfo(bytes);
  if (!info) throw ttsProviderError('WAV crop only supports PCM wav', 502);
  const bytesPerMs = info.sampleRate * info.blockAlign / 1000;
  const durationMs = info.dataSize / bytesPerMs;
  let clipStartMs = Math.max(0, startMs - padStartMs);
  let clipEndMs = Math.min(durationMs, endMs + padEndMs);
  const minDurationMs = Number(opts.minDurationMs || 0);
  if (minDurationMs && clipEndMs - clipStartMs < minDurationMs) {
    const mid = (startMs + endMs) / 2;
    const half = minDurationMs / 2;
    clipStartMs = Math.max(0, mid - half);
    clipEndMs = Math.min(durationMs, mid + half);
    if (clipEndMs - clipStartMs < minDurationMs) {
      if (clipStartMs <= 0) clipEndMs = Math.min(durationMs, clipStartMs + minDurationMs);
      else if (clipEndMs >= durationMs) clipStartMs = Math.max(0, clipEndMs - minDurationMs);
    }
  }
  let start = Math.max(0, Math.floor(clipStartMs * bytesPerMs));
  let end = Math.min(info.dataSize, Math.ceil(clipEndMs * bytesPerMs));
  start -= start % info.blockAlign;
  end -= end % info.blockAlign;
  if (end <= start) throw ttsProviderError(`Invalid crop range: ${startMs}-${endMs}`, 502);
  let pcm = bytes.slice(info.dataOffset + start, info.dataOffset + end);
  const tailSilenceToMs = Number(opts.tailSilenceToMs || 0);
  if (tailSilenceToMs) {
    const currentMs = pcm.length / bytesPerMs;
    if (currentMs < tailSilenceToMs) {
      const silenceBytes = Math.max(0, Math.round((tailSilenceToMs - currentMs) * bytesPerMs));
      const silence = new Uint8Array(silenceBytes - (silenceBytes % info.blockAlign));
      const padded = new Uint8Array(pcm.length + silence.length);
      padded.set(pcm);
      padded.set(silence, pcm.length);
      pcm = padded;
    }
  }
  return makePcmWav(pcm, info.sampleRate, info.channels, info.bitsPerSample);
}
function cropFirstActiveWavSegment(bytes) {
  const info = parseWavInfo(bytes);
  if (!info || info.bitsPerSample !== 16) throw ttsProviderError('Energy crop only supports 16-bit PCM wav', 502);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameBytes = info.blockAlign;
  const totalFrames = Math.floor(info.dataSize / frameBytes);
  const windowFrames = Math.max(1, Math.floor(info.sampleRate * 0.012));
  const energies = [];
  let peak = 0;
  for (let start = 0; start < totalFrames; start += windowFrames) {
    const end = Math.min(totalFrames, start + windowFrames);
    let sum = 0;
    let count = 0;
    for (let f = start; f < end; f++) {
      const offset = info.dataOffset + f * frameBytes;
      for (let ch = 0; ch < info.channels; ch++) {
        sum += Math.abs(view.getInt16(offset + ch * 2, true));
        count++;
      }
    }
    const e = count ? sum / count : 0;
    peak = Math.max(peak, e);
    energies.push({ start, end, e });
  }
  const threshold = Math.max(260, peak * 0.16);
  let activeStart = -1;
  let activeEnd = -1;
  const segments = [];
  for (const w of energies) {
    if (w.e >= threshold) {
      if (activeStart < 0) activeStart = w.start;
      activeEnd = w.end;
    } else if (activeStart >= 0) {
      if ((activeEnd - activeStart) / info.sampleRate >= 0.06) segments.push([activeStart, activeEnd]);
      activeStart = -1;
      activeEnd = -1;
    }
  }
  if (activeStart >= 0) segments.push([activeStart, activeEnd]);
  if (!segments.length) throw ttsProviderError(`Energy crop found no active segment: peak=${Math.round(peak)}`, 502);
  let [startFrame, endFrame] = segments[0];
  if (segments.length === 1) {
    const dur = endFrame - startFrame;
    endFrame = startFrame + Math.max(Math.floor(info.sampleRate * 0.18), Math.floor(dur * 0.46));
  }
  startFrame = Math.max(0, startFrame - Math.floor(info.sampleRate * 0.012));
  endFrame = Math.min(totalFrames, endFrame + Math.floor(info.sampleRate * 0.028));
  const pcmStart = startFrame * frameBytes;
  const pcmEnd = endFrame * frameBytes;
  const pcm = bytes.slice(info.dataOffset + pcmStart, info.dataOffset + pcmEnd);
  return {
    bytes: makePcmWav(pcm, info.sampleRate, info.channels, info.bitsPerSample),
    range: { source: 'energy-first-segment', startMs: Math.round(startFrame * 1000 / info.sampleRate), endMs: Math.round(endFrame * 1000 / info.sampleRate), peak: Math.round(peak), threshold: Math.round(threshold), segments: segments.map(([a, b]) => [Math.round(a * 1000 / info.sampleRate), Math.round(b * 1000 / info.sampleRate)]) }
  };
}

function findTargetWord(words, target) {
  const t = String(target || '').trim();
  if (!t || !Array.isArray(words)) return null;
  const exact = words.find(w => String(w.text || '') === t && Number.isFinite(w.begin_time) && Number.isFinite(w.end_time) && w.end_time > w.begin_time);
  if (exact) return { ...exact, source: 'exact' };
  for (const w of words) {
    const txt = String(w.text || '');
    const pos = txt.indexOf(t);
    if (pos < 0 || !Number.isFinite(w.begin_time) || !Number.isFinite(w.end_time) || w.end_time <= w.begin_time) continue;
    const chars = Array.from(txt);
    const targetChars = Array.from(t);
    const charPos = Array.from(txt.slice(0, pos)).length;
    const span = Math.max(1, chars.length);
    const dur = w.end_time - w.begin_time;
    return {
      text: t,
      begin_index: (w.begin_index || 0) + charPos,
      end_index: (w.begin_index || 0) + charPos + targetChars.length,
      begin_time: w.begin_time + dur * (charPos / span),
      end_time: w.begin_time + dur * ((charPos + targetChars.length) / span),
      source: 'split-word',
      original_word: w,
    };
  }
  return null;
}

function sourceCounts(list) {
  const out = {};
  for (const item of Array.isArray(list) ? list : []) {
    const key = item || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function cosyWordText(word) {
  return String(word?.text ?? word?.word ?? '').trim();
}

function cosyWordBegin(word) {
  const value = word?.begin_time ?? word?.time_begin;
  return Number.isFinite(value) ? value : Number(value);
}

function cosyWordEnd(word) {
  const value = word?.end_time ?? word?.time_end;
  return Number.isFinite(value) ? value : Number(value);
}

function buildCharTimeFromCosyWords(words, text, audioDurationMs) {
  const idx = buildTextIndex(text);
  const charTime = new Array(idx.chars.length);
  const sources = new Array(idx.chars.length);
  const groups = new Array(idx.chars.length);
  let cursor = 0;

  for (let i = 0; i < (Array.isArray(words) ? words.length : 0); i++) {
    const word = words[i];
    const wordText = cosyWordText(word);
    const timeBegin = cosyWordBegin(word);
    const timeEnd = cosyWordEnd(word);
    if (!wordText || !Number.isFinite(timeBegin) || !Number.isFinite(timeEnd) || timeEnd <= timeBegin) continue;

    let candidates = [];
    if (word?.begin_index != null && word?.end_index != null) candidates = candidates.concat(offsetCandidates(idx, word.begin_index, word.end_index, wordText, 'cosy-word'));
    if (word?.text_begin != null && word?.text_end != null) candidates = candidates.concat(offsetCandidates(idx, word.text_begin, word.text_end, wordText, 'cosy-word-text'));
    candidates = candidates.filter(c => c.score >= 3 && c.end > c.start);
    candidates.sort((a, b) => b.score - a.score);
    const range = candidates[0] || findTextRange(idx, wordText, cursor);
    if (!range) continue;

    const sourceLabel = range.end - range.start === 1 ? 'char' : 'word';
    const groupId = `${sourceLabel}:${i}:${range.start}-${range.end}`;
    if (applyTimedRange(charTime, sources, groups, range, timeBegin, timeEnd, sourceLabel, groupId)) {
      cursor = Math.max(cursor, range.end);
    }
  }

  fillCharTimeGaps(charTime, audioDurationMs, sources);
  return { charTime, sources, groups };
}

function summarizeCosyWords(words) {
  return (Array.isArray(words) ? words : []).slice(0, 80).map((word, idx) => ({
    idx,
    text: cosyWordText(word),
    begin_index: word?.begin_index,
    end_index: word?.end_index,
    text_begin: word?.text_begin,
    text_end: word?.text_end,
    begin_time: cosyWordBegin(word),
    end_time: cosyWordEnd(word),
  }));
}

function isSingleCjk(text) {
  return /^[\u3400-\u9fff]$/u.test(String(text || '').trim());
}

function normalizeCosyText(text) {
  const raw = String(text || '').trim();
  if (isSingleCjk(raw)) return raw + '。';
  return raw;
}

function cosyWsUrl(env) {
  const explicit = env.COSYVOICE_WS_URL || env.DASHSCOPE_WS_URL || '';
  if (explicit) return explicit;
  const workspaceId = env.DASHSCOPE_WORKSPACE_ID || env.COSYVOICE_WORKSPACE_ID || env.ALIYUN_WORKSPACE_ID || '';
  const region = env.DASHSCOPE_REGION || env.COSYVOICE_REGION || 'cn-beijing';
  if (workspaceId) return `wss://${workspaceId}.${region}.maas.aliyuncs.com/api-ws/v1/inference`;
  return 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
}

function wsTextPayload(data) {
  if (typeof data === 'string') return data;
  try {
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  } catch {}
  return '';
}

async function openCosyWs(env, apiKey) {
  const wsUrl = cosyWsUrl(env);
  const headers = {
    'Authorization': 'Bearer ' + apiKey,
    'User-Agent': 'xueyy-cosyvoice-worker/1.0',
    'Upgrade': 'websocket',
  };
  const workspaceId = env.DASHSCOPE_WORKSPACE_ID || env.COSYVOICE_WORKSPACE_ID || env.ALIYUN_WORKSPACE_ID || '';
  if (workspaceId) headers['X-DashScope-WorkSpace'] = workspaceId;
  const fetchUrl = wsUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  const resp = await fetch(fetchUrl, { headers });
  if (resp.status !== 101 || !resp.webSocket) {
    let txt = '';
    try { txt = await resp.text(); } catch {}
    throw ttsProviderError(`CosyVoice WebSocket connect failed: ${resp.status}${txt ? ': ' + txt.slice(0, 180) : ''}`, resp.status || 502);
  }
  const ws = resp.webSocket;
  ws.accept();
  return { ws, wsUrl };
}

function closeWsQuietly(ws, code = 1000, reason = 'done') {
  try { ws.close(code, reason); } catch {}
}

async function runCosyWsTask(env, apiKey, request) {
  const { ws, wsUrl } = await openCosyWs(env, apiKey);
  const taskId = crypto.randomUUID();
  const chunks = [];
  const events = [];
  const outputs = [];
  let words = [];
  let lastData = {};
  let sentText = false;
  let finishSent = false;
  let finished = false;

  const parameters = {
    text_type: 'PlainText',
    voice: request.voice,
    format: request.format,
    sample_rate: request.sampleRate,
    volume: request.volume,
    rate: request.rate,
    pitch: request.pitch,
    enable_ssml: !!request.enableSsml,
    language_hints: request.languageHints,
    enable_aigc_tag: !!request.enableAigcTag,
    word_timestamp_enabled: !!request.wordTimestampEnabled,
  };
  if (request.instruction) parameters.instruction = request.instruction;
  if (request.hotFix) parameters.hot_fix = request.hotFix;

  const runTask = {
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'tts',
      function: 'SpeechSynthesizer',
      model: request.model,
      parameters,
      input: {},
    },
  };
  const continueTask = {
    header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: { text: request.text } },
  };
  const finishTask = {
    header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: {} },
  };

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      closeWsQuietly(ws, 1011, 'timeout');
      reject(ttsProviderError(`CosyVoice WebSocket timeout: events=${events.join(',')}; chunks=${chunks.length}`, 504));
    }, Number(env.COSYVOICE_WS_TIMEOUT_MS || 35000));

    const fail = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      closeWsQuietly(ws, 1011, 'failed');
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      closeWsQuietly(ws);
      resolve({ bytes: concatByteChunks(chunks), data: lastData, chunks: chunks.length, events, outputs, words, parameters, taskId, wsUrl });
    };

    ws.addEventListener('message', async (event) => {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        chunks.push(new Uint8Array(data));
        return;
      }
      if (data && typeof data !== 'string' && typeof data.arrayBuffer === 'function') {
        try { chunks.push(new Uint8Array(await data.arrayBuffer())); } catch (e) { fail(e); }
        return;
      }
      const txt = wsTextPayload(data);
      if (!txt) return;
      let msg = null;
      try { msg = JSON.parse(txt); } catch { return; }
      lastData = msg;
      const headerEvent = msg?.header?.event || '';
      const output = msg?.payload?.output || null;
      if (output) {
        outputs.push(output);
        if (Array.isArray(output?.sentence?.words) && output.sentence.words.length) words = output.sentence.words;
      }
      const outputType = output?.type || '';
      const eventName = outputType ? `${headerEvent}:${outputType}` : headerEvent;
      if (eventName) events.push(eventName);
      if (headerEvent === 'task-started' && !sentText) {
        sentText = true;
        ws.send(JSON.stringify(continueTask));
        if (!finished && !finishSent) {
          finishSent = true;
          try { ws.send(JSON.stringify(finishTask)); } catch (e) { fail(e); }
        }
      } else if (headerEvent === 'task-failed') {
        fail(ttsProviderError(msg?.header?.error_message || msg?.header?.error_code || 'CosyVoice task failed', 502));
      } else if (headerEvent === 'task-finished') {
        done();
      }
    });
    ws.addEventListener('close', () => {
      if (!finished) done();
    });
    ws.addEventListener('error', (event) => {
      fail(ttsProviderError(`CosyVoice WebSocket error: ${event?.message || 'unknown'}`, 502));
    });

    ws.send(JSON.stringify(runTask));
  });
}

async function cosyVoiceTts(env, body, opts = {}) {
  const apiKey = env.DASHSCOPE_API_KEY || env.COSYVOICE_API_KEY || env.ALIYUN_API_KEY || '';
  if (!apiKey) throw new Error('CosyVoice not configured: missing DASHSCOPE_API_KEY');
  await waitForTtsSlot('cosyVoiceTts');

  const audioFormat = opts.format || body.format || 'wav';
  const model = body.model || opts.model || env.COSYVOICE_MODEL || 'cosyvoice-v3-flash';
  const voice = body.voice || opts.voice || env.COSYVOICE_VOICE || 'longanyue_v3';
  const rate = Number(body.rate ?? body.speed ?? opts.rate ?? 1.0);
  const sampleRate = Number(body.sample_rate || opts.sample_rate || 24000);
  const explicitInstruction = body.instruction ?? opts.instruction;
  const instruction = explicitInstruction != null ? explicitInstruction : defaultCosyInstruction(env, voice);


  const request = {
    text: normalizeCosyText(body.text),
    voice,
    format: audioFormat,
    sampleRate,
    volume: Number(body.volume ?? opts.volume ?? defaultCosyVolume(voice)),
    rate: Number.isFinite(rate) ? Math.max(0.5, Math.min(2.0, rate)) : 1.0,
    pitch: Number(body.pitch ?? opts.pitch ?? defaultCosyPitch(voice)),
    languageHints: body.language_hints || opts.language_hints || ['zh'],
    enableAigcTag: body.enable_aigc_tag ?? opts.enable_aigc_tag ?? false,
    enableSsml: body.enable_ssml || opts.enable_ssml,
    wordTimestampEnabled: body.word_timestamp_enabled || opts.word_timestamp_enabled,
    hotFix: body.hot_fix || opts.hot_fix || null,
    instruction,
    model,
  };

  const out = await runCosyWsTask(env, apiKey, request);
  if (!out.bytes || !out.bytes.length) {
    throw ttsProviderError(`CosyVoice WebSocket returned no audio: events=${out.events.join(',')}; task=${out.taskId}`, 502);
  }
  const audioDebug = validateAudioBytes(out.bytes, audioFormat, 'CosyVoice');
  return { data: out.data, bytes: out.bytes, format: audioFormat, model, voice, sampleRate, provider: 'cosyvoice-ws', requestText: request.text, parameters: out.parameters, audioDebug, chunks: out.chunks, events: out.events, words: out.words, outputs: out.outputs, taskId: out.taskId };
}

function qwenTtsGenerationUrl(env) {
  const explicit = env.QWEN_TTS_GENERATION_URL || env.DASHSCOPE_GENERATION_URL || '';
  if (explicit) return explicit;
  const workspaceId = env.DASHSCOPE_WORKSPACE_ID || env.QWEN_TTS_WORKSPACE_ID || env.ALIYUN_WORKSPACE_ID || '';
  const region = env.DASHSCOPE_REGION || env.QWEN_TTS_REGION || 'cn-beijing';
  if (workspaceId) return `https://${workspaceId}.${region}.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`;
  return 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
}

function normalizeQwenVoice(voice) {
  const raw = String(voice || '').trim();
  if (!raw || /^longan/i.test(raw) || /^cosy/i.test(raw)) return QWEN_TTS_DEFAULT_VOICE;
  return raw;
}

function normalizeQwenModel(model) {
  const raw = String(model || '').trim();
  if (!raw || /^cosyvoice/i.test(raw)) return QWEN_TTS_DEFAULT_MODEL;
  return raw;
}

function isQwenInstructModel(model) {
  return /qwen3-tts-instruct-flash/i.test(String(model || ''));
}

function normalizeQwenText(text) {
  const raw = String(text || '').trim();
  if (isSingleCjk(raw)) return raw + '\u3002';
  return raw;
}

function qwenAudioUrlFromResponse(data) {
  const audio = data?.output?.audio;
  const candidates = [
    typeof audio === 'string' ? audio : '',
    audio?.url,
    data?.output?.audio_url,
    data?.output?.url,
    data?.audio?.url,
    data?.url,
  ];
  return candidates.find(value => typeof value === 'string' && /^https?:/i.test(value.trim())) || '';
}

function qwenAudioBytesFromResponse(data) {
  const audio = data?.output?.audio || data?.audio || {};
  for (const value of [audio.data, audio.audio, audio.base64, data?.output?.audio_data, data?.audio_data]) {
    const bytes = decodeAudioPayload(value);
    if (bytes?.length) return bytes;
  }
  return null;
}

async function qwenTts(env, body, opts = {}) {
  const apiKey = env.DASHSCOPE_API_KEY || env.QWEN_TTS_API_KEY || env.COSYVOICE_API_KEY || env.ALIYUN_API_KEY || '';
  if (!apiKey) throw new Error('Qwen TTS not configured: missing DASHSCOPE_API_KEY');
  await waitForTtsSlot('qwenTts');

  const model = normalizeQwenModel(body.model || opts.model || env.QWEN_TTS_MODEL || env.DASHSCOPE_TTS_MODEL || QWEN_TTS_DEFAULT_MODEL);
  const voice = normalizeQwenVoice(body.voice || opts.voice || env.QWEN_TTS_VOICE || QWEN_TTS_DEFAULT_VOICE);
  const requestText = normalizeQwenText(body.text);
  if (!requestText) throw ttsProviderError('Qwen TTS text is empty', 400);
  const generationUrl = qwenTtsGenerationUrl(env);
  const instructions = String(body.instructions ?? body.instruction ?? opts.instructions ?? opts.instruction ?? '').trim();
  const optimizeInstructions = body.optimize_instructions ?? opts.optimize_instructions;
  const canUseInstructions = isQwenInstructModel(model);
  const payload = {
    model,
    input: {
      text: requestText,
      voice,
      language_type: body.language_type || opts.language_type || env.QWEN_TTS_LANGUAGE_TYPE || 'Chinese',
    },
  };
  if (instructions && canUseInstructions) {
    payload.input.instructions = instructions;
    if (optimizeInstructions != null) payload.input.optimize_instructions = !!optimizeInstructions;
  }
  const resp = await fetch(generationUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'xueyy-qwen-tts-worker/1.0',
    },
    body: JSON.stringify(payload),
  });
  const responseText = await resp.text();
  let data = null;
  try { data = responseText ? JSON.parse(responseText) : {}; } catch {}
  if (!resp.ok) {
    const msg = data?.message || data?.error?.message || data?.code || responseText.slice(0, 240) || `HTTP ${resp.status}`;
    throw ttsProviderError(`Qwen TTS request failed: ${msg}`, resp.status || 502);
  }
  if (!data) throw ttsProviderError(`Qwen TTS returned non-json response: ${responseText.slice(0, 120)}`, 502);

  let bytes = qwenAudioBytesFromResponse(data);
  const audioUrl = qwenAudioUrlFromResponse(data);
  const events = ['http:generation'];
  let audioContentType = '';
  if (!bytes?.length && audioUrl) {
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) throw ttsProviderError(`Qwen TTS audio download failed: ${audioResp.status}`, audioResp.status || 502);
    audioContentType = audioResp.headers.get('Content-Type') || '';
    bytes = new Uint8Array(await audioResp.arrayBuffer());
    events.push('audio:url-download');
  }
  if (!bytes?.length) throw ttsProviderError('Qwen TTS returned no audio URL or audio payload', 502);
  const format = 'wav';
  const audioDebug = validateAudioBytes(bytes, format, 'Qwen TTS');
  const parameters = {
    voice,
    model,
    endpoint: generationUrl,
    audio_url: audioUrl ? 'present' : '',
    audio_content_type: audioContentType,
    language_type: payload.input.language_type,
    instructions_sent: !!payload.input.instructions,
    instructions_ignored: !!instructions && !canUseInstructions ? 'model-not-instruct' : '',
    optimize_instructions: payload.input.optimize_instructions ?? false,
    request_id: data?.request_id || '',
    usage: data?.usage || null,
  };
  return {
    data,
    bytes,
    format,
    model,
    voice,
    sampleRate: Number(body.sample_rate || opts.sample_rate || 24000),
    provider: 'qwen-tts-http',
    requestText,
    parameters,
    audioDebug,
    chunks: 1,
    events,
    words: [],
    outputs: data?.output ? [data.output] : [],
    taskId: data?.request_id || data?.output?.task_id || '',
  };
}

function isPunctuationChar(ch) {
  return /[\u3000\s，、。！？；：,.!?;:]/u.test(String(ch || ''));
}

function charTimelineWeight(ch) {
  if (!ch) return 0;
  if (/\s/u.test(ch)) return 0.06;
  if (/[。！？.!?]/u.test(ch)) return 0.22;
  if (/[，、；：,;:]/u.test(ch)) return 0.16;
  if (/[\u3400-\u9fff]/u.test(ch)) return 1.0;
  return 0.62;
}

function qwenEnergyWindowsFromWav(bytes, info) {
  if (!info || info.bitsPerSample !== 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameBytes = info.blockAlign;
  const totalFrames = Math.floor(info.dataSize / frameBytes);
  if (!totalFrames) return null;
  const windowMs = 18;
  const windowFrames = Math.max(1, Math.floor(info.sampleRate * windowMs / 1000));
  let peak = 0;
  const windows = [];
  for (let start = 0; start < totalFrames; start += windowFrames) {
    const end = Math.min(totalFrames, start + windowFrames);
    let sum = 0, count = 0;
    for (let f = start; f < end; f++) {
      const offset = info.dataOffset + f * frameBytes;
      for (let ch = 0; ch < info.channels; ch++) {
        sum += Math.abs(view.getInt16(offset + ch * 2, true));
        count++;
      }
    }
    const e = count ? sum / count : 0;
    peak = Math.max(peak, e);
    windows.push({ start, end, e });
  }
  return { windows, peak, windowMs };
}

function qwenActiveSpeechAnalysisFromWav(bytes, info) {
  const energy = qwenEnergyWindowsFromWav(bytes, info);
  if (!energy || !energy.windows.length || energy.peak <= 0) return null;
  const durationMs = info.dataSize / (info.sampleRate * info.blockAlign / 1000);
  const threshold = Math.max(180, energy.peak * 0.10);
  const raw = [];
  let activeStart = -1;
  let activeEnd = -1;
  for (const w of energy.windows) {
    if (w.e >= threshold) {
      if (activeStart < 0) activeStart = w.start;
      activeEnd = w.end;
    } else if (activeStart >= 0) {
      if ((activeEnd - activeStart) * 1000 / info.sampleRate >= 55) raw.push([activeStart, activeEnd]);
      activeStart = -1;
      activeEnd = -1;
    }
  }
  if (activeStart >= 0 && (activeEnd - activeStart) * 1000 / info.sampleRate >= 55) raw.push([activeStart, activeEnd]);
  if (!raw.length) return null;

  const padded = raw.map(([a, b]) => ({
    startMs: Math.max(0, Math.round(a * 1000 / info.sampleRate) - 24),
    endMs: Math.min(durationMs, Math.round(b * 1000 / info.sampleRate) + 70),
  }));
  const merged = [];
  for (const seg of padded) {
    const last = merged[merged.length - 1];
    if (last && seg.startMs - last.endMs <= 85) {
      last.endMs = Math.max(last.endMs, seg.endMs);
    } else {
      merged.push({ ...seg });
    }
  }
  const cleaned = [];
  for (const seg of merged) {
    const dur = seg.endMs - seg.startMs;
    const last = cleaned[cleaned.length - 1];
    if (last && dur < 80) {
      last.endMs = Math.max(last.endMs, seg.endMs);
    } else {
      cleaned.push(seg);
    }
  }
  const segments = cleaned.length ? cleaned : padded;
  const active = {
    startMs: segments[0].startMs,
    endMs: segments[segments.length - 1].endMs,
    peak: Math.round(energy.peak),
    threshold: Math.round(threshold),
  };
  return { active, segments, peak: Math.round(energy.peak), threshold: Math.round(threshold), windowMs: energy.windowMs };
}

function activeSpeechBoundsFromWav(bytes, info) {
  return qwenActiveSpeechAnalysisFromWav(bytes, info)?.active || null;
}

function qwenTextRuns(chars) {
  const runs = [];
  let i = 0;
  while (i < chars.length) {
    const start = i;
    const punct = isPunctuationChar(chars[i]);
    let weight = 0;
    while (i < chars.length && isPunctuationChar(chars[i]) === punct) {
      weight += Math.max(0.01, charTimelineWeight(chars[i]));
      i++;
    }
    runs.push({ type: punct ? 'punct' : 'speech', start, end: i, text: chars.slice(start, i).join(''), weight });
  }
  return runs;
}

function assignQwenTimedChars(charTime, sources, groups, chars, start, end, timeBegin, timeEnd, sourceLabel, groupId) {
  if (end <= start || !Number.isFinite(timeBegin) || !Number.isFinite(timeEnd) || timeEnd <= timeBegin) return;
  const weights = [];
  let total = 0;
  for (let i = start; i < end; i++) {
    const w = Math.max(0.01, charTimelineWeight(chars[i]));
    weights.push(w);
    total += w;
  }
  if (!(total > 0)) total = end - start;
  let cursor = timeBegin;
  for (let i = start; i < end; i++) {
    const idx = i - start;
    const next = i === end - 1 ? timeEnd : cursor + (timeEnd - timeBegin) * (weights[idx] / total);
    charTime[i] = [cursor, Math.max(cursor + 1, next)];
    sources[i] = sourceLabel;
    groups[i] = groupId;
    cursor = next;
  }
}

function assignQwenSegmentsToSpeechRuns(charTime, sources, groups, chars, speechRuns, segments, active) {
  if (!speechRuns.length) return false;
  if (!segments?.length || segments.length < speechRuns.length) {
    const total = speechRuns.reduce((sum, r) => sum + r.weight, 0) || speechRuns.length;
    let cursor = active.startMs;
    for (let i = 0; i < speechRuns.length; i++) {
      const run = speechRuns[i];
      const next = i === speechRuns.length - 1 ? active.endMs : cursor + (active.endMs - active.startMs) * (run.weight / total);
      assignQwenTimedChars(charTime, sources, groups, chars, run.start, run.end, cursor, next, 'qwen_run_est', `qwen-run:${i}:${run.start}-${run.end}`);
      cursor = next;
    }
    return true;
  }

  const totalRunWeight = speechRuns.reduce((sum, r) => sum + r.weight, 0) || speechRuns.length;
  const totalSegDur = segments.reduce((sum, seg) => sum + Math.max(1, seg.endMs - seg.startMs), 0) || Math.max(1, active.endMs - active.startMs);
  const cumulativeSegDur = [];
  let segSum = 0;
  for (const seg of segments) {
    segSum += Math.max(1, seg.endMs - seg.startMs);
    cumulativeSegDur.push(segSum);
  }
  let segIndex = 0;
  let runWeightSeen = 0;
  for (let i = 0; i < speechRuns.length; i++) {
    const run = speechRuns[i];
    const startSeg = Math.min(segIndex, segments.length - 1);
    let endSeg = startSeg;
    if (i === speechRuns.length - 1) {
      endSeg = segments.length - 1;
    } else {
      runWeightSeen += run.weight;
      const targetDur = totalSegDur * (runWeightSeen / totalRunWeight);
      const maxEndSeg = Math.max(startSeg, segments.length - (speechRuns.length - i));
      while (endSeg < maxEndSeg && cumulativeSegDur[endSeg] < targetDur) endSeg++;
    }
    const segStart = segments[startSeg]?.startMs ?? active.startMs;
    const segEnd = segments[endSeg]?.endMs ?? active.endMs;
    assignQwenTimedChars(charTime, sources, groups, chars, run.start, run.end, segStart, Math.max(segStart + 1, segEnd), 'qwen_segment_est', `qwen-seg:${i}:${run.start}-${run.end}`);
    segIndex = endSeg + 1;
  }
  return true;
}

function assignQwenPunctuationGaps(charTime, sources, groups, chars, runs, active, audioDurationMs) {
  for (const run of runs) {
    if (run.type !== 'punct') continue;
    let prev = run.start - 1;
    while (prev >= 0 && !charTime[prev]) prev--;
    let next = run.end;
    while (next < charTime.length && !charTime[next]) next++;
    const gapStart = prev >= 0 ? charTime[prev][1] : active.startMs;
    let gapEnd = next < charTime.length ? charTime[next][0] : active.endMs;
    if (!Number.isFinite(gapEnd) || gapEnd <= gapStart) gapEnd = Math.min(audioDurationMs, gapStart + Math.max(1, run.weight * 24));
    assignQwenTimedChars(charTime, sources, groups, chars, run.start, run.end, gapStart, gapEnd, 'qwen_punct_gap', `qwen-punct:${run.start}-${run.end}`);
  }
}

function buildCharTimeFromQwenEstimate(bytes, text, wavInfo) {
  const chars = Array.from(text || '');
  const info = wavInfo || parseWavInfo(bytes);
  const charTime = new Array(chars.length);
  const sources = new Array(chars.length);
  const groups = new Array(chars.length);
  if (!info || !chars.length) return { charTime, sources, groups, active: null, segments: [], runs: [], strategy: 'qwen-empty' };
  const audioDurationMs = info.dataSize / (info.sampleRate * info.blockAlign / 1000);
  const analysis = qwenActiveSpeechAnalysisFromWav(bytes, info);
  const active = analysis?.active || { startMs: 0, endMs: audioDurationMs, peak: 0, threshold: 0 };
  const runs = qwenTextRuns(chars);
  const speechRuns = runs.filter(run => run.type === 'speech');
  const assigned = assignQwenSegmentsToSpeechRuns(charTime, sources, groups, chars, speechRuns, analysis?.segments || [], active);
  if (!assigned) assignQwenTimedChars(charTime, sources, groups, chars, 0, chars.length, active.startMs, active.endMs, 'qwen_char_est', 'qwen-all');
  assignQwenPunctuationGaps(charTime, sources, groups, chars, runs, active, audioDurationMs);
  fillCharTimeGaps(charTime, audioDurationMs, sources);
  for (let i = 0; i < groups.length; i++) if (!groups[i]) groups[i] = sources[i] || 'qwen_gap';
  return {
    charTime,
    sources,
    groups,
    active,
    segments: analysis?.segments || [],
    runs,
    strategy: analysis?.segments?.length ? 'qwen-energy-segment-runs' : 'qwen-active-weighted-runs',
  };
}

function qwenEstimatedTargetWord(bytes, carrierText, target) {
  const wav = parseWavInfo(bytes);
  if (!wav) return null;
  const timeline = buildCharTimeFromQwenEstimate(bytes, carrierText, wav);
  const chars = Array.from(carrierText || '');
  const targetChars = Array.from(String(target || ''));
  if (!targetChars.length) return null;
  let idx = -1;
  for (let i = 0; i <= chars.length - targetChars.length; i++) {
    let ok = true;
    for (let j = 0; j < targetChars.length; j++) if (chars[i + j] !== targetChars[j]) ok = false;
    if (ok) { idx = i; break; }
  }
  if (idx < 0) return null;
  const first = timeline.charTime[idx];
  const last = timeline.charTime[idx + targetChars.length - 1];
  if (!first || !last) return null;
  return {
    text: target,
    begin_index: idx,
    end_index: idx + targetChars.length,
    begin_time: first[0],
    end_time: last[1],
    source: 'qwen-estimated-char',
    active: timeline.active,
  };
}

function summarizeQwenTimeline(timeline, text) {
  const chars = Array.from(text || '');
  return chars.slice(0, 80).map((ch, idx) => ({
    idx,
    text: ch,
    begin_time: timeline.charTime[idx]?.[0],
    end_time: timeline.charTime[idx]?.[1],
    source: timeline.sources[idx],
  }));
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
// addSentencePauses 是旧字幕对齐流程遗留函数；在线 TTS 模式下不再使用字幕裁切。
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
  const text = String(body?.text || '').trim();
  if (!text) throw ttsProviderError('预处理文本不能为空', 400);
  const voice = normalizeQwenVoice(body?.voice || env.QWEN_TTS_VOICE || QWEN_TTS_DEFAULT_VOICE);
  const model = normalizeQwenModel(body?.model || env.QWEN_TTS_MODEL || QWEN_TTS_DEFAULT_MODEL);
  const sampleRate = Number(body?.sample_rate || 24000);

  const out = await qwenTts(env, {
    text,
    voice,
    model,
    format: 'wav',
    sample_rate: sampleRate,
    language_type: body?.language_type,
    instructions: body?.instructions,
    instruction: body?.instruction,
    optimize_instructions: body?.optimize_instructions,
  });
  const wav = parseWavInfo(out.bytes);
  if (!wav) throw ttsProviderError('Qwen TTS 预处理仅支持 PCM WAV 输出', 502);
  const audioDurationMs = wav.dataSize / (wav.sampleRate * wav.blockAlign / 1000);
  const timeline = buildCharTimeFromQwenEstimate(out.bytes, text, wav);
  const total = Array.from(text).length;
  const covered = timeline.charTime.filter(Boolean).length;
  if (!covered) throw ttsProviderError(`Qwen TTS 时间线估算失败: voice=${voice}; durationMs=${Math.round(audioDurationMs)}`, 502);
  return {
    text,
    audio_hex: bytesToHex(out.bytes),
    data_off: wav.dataOffset,
    data_size: wav.dataSize,
    sr: wav.sampleRate,
    ch: wav.channels,
    bits: wav.bitsPerSample,
    char_time: timeline.charTime.map(x => x ? [Math.round(x[0]), Math.round(x[1])] : null),
    char_source: timeline.sources,
    char_group: timeline.groups,
    char_count: total,
    coverage: { covered, total, sources: sourceCounts(timeline.sources), active: timeline.active, segments: timeline.segments, strategy: timeline.strategy },
    subtitle_debug: summarizeQwenTimeline(timeline, text),
    provider: out.provider,
    voice: out.voice,
    model: out.model,
    request_text: out.requestText,
    parameters: out.parameters,
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
      const apiKey = env.DASHSCOPE_API_KEY || env.QWEN_TTS_API_KEY || env.COSYVOICE_API_KEY || env.ALIYUN_API_KEY || '';
      results.push('Provider: Qwen TTS');
      results.push('Key: ' + (apiKey ? '已设('+apiKey.slice(0,6)+'...)' : '未设'));
      if (!apiKey) {
        return new Response(results.join(' | '), { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
      }
      // 测试 Qwen TTS 请求
      try {
        const healthVoice = env.QWEN_TTS_VOICE || QWEN_TTS_DEFAULT_VOICE;
        const out = await qwenTts(env, { text: '\u4f60\u597d\u4e16\u754c', voice: healthVoice, format: 'wav', sample_rate: 24000 });
        results.push('API: OK');
        results.push('audio: ' + out.bytes.length + ' bytes');
        results.push('model: ' + out.model);
        results.push('voice: ' + out.voice);
        results.push('requestText: ' + out.requestText);
        results.push('provider: ' + out.provider);
        results.push('format: ' + out.format);
        results.push('events: ' + out.events.join(','));
        results.push('audioDebug: ' + JSON.stringify(out.audioDebug));
        results.push('params: ' + JSON.stringify({
          endpoint: out.parameters?.endpoint,
          audio_url: out.parameters?.audio_url,
          audio_content_type: out.parameters?.audio_content_type,
          language_type: out.parameters?.language_type,
          instructions_sent: out.parameters?.instructions_sent,
          instructions_ignored: out.parameters?.instructions_ignored,
          optimize_instructions: out.parameters?.optimize_instructions,
          request_id: out.parameters?.request_id,
          usage: out.parameters?.usage,
        }));
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
      const debugVoice = normalizeQwenVoice(url.searchParams.get('voice') || env.QWEN_TTS_VOICE || QWEN_TTS_DEFAULT_VOICE);
      const debugModel = normalizeQwenModel(url.searchParams.get('model') || env.QWEN_TTS_MODEL || QWEN_TTS_DEFAULT_MODEL);
      const debugInstructions = String(url.searchParams.get('instructions') || '').trim();
      const debugOptimizeInstructions = url.searchParams.get('optimize_instructions') === '1' || url.searchParams.get('optimize') === '1';
      const runAll = url.searchParams.get('all') === '1';
      const allowEnergyFallback = url.searchParams.get('fallback') === '1';
      const single = isSingleCjk(text);
      const carrierText = single ? `${text}\u3002` : text;
      const debugControls = debugInstructions ? { instructions: debugInstructions, optimize_instructions: debugOptimizeInstructions } : {};
      const baseBody = single ? { text: carrierText, teaching_target: text, word_timestamp_enabled: true, ...debugControls } : { text, ...debugControls };
      const alternateVoice = debugVoice === 'Rocky' ? 'Kiki' : 'Rocky';
      const variantBaseLabel = single ? `Qwen carrier: ${carrierText}` : 'Qwen TTS';
      const allVariants = [
        { id: 'selected', label: `${variantBaseLabel} / ${debugVoice}`, voice: debugVoice, body: baseBody },
        { id: 'alt-cantonese', label: `${variantBaseLabel} / ${alternateVoice}`, voice: alternateVoice, body: baseBody },
      ];
      const variants = runAll ? allVariants : [allVariants[0]];
      const rows = [];
      for (const v of variants) {
        try {
          const out = await qwenTts(env, {
            ...v.body,
            voice: v.voice || debugVoice,
            model: debugModel,
            format: 'wav',
            sample_rate: 24000,
          });
          let bin = '';
          for (const b of out.bytes) bin += String.fromCharCode(b);
          const b64 = btoa(bin);
          const mime = out.format === 'mp3' ? 'audio/mpeg' : (out.format === 'opus' ? 'audio/ogg' : 'audio/wav');
          const wavInfo = out.format === 'wav' ? parseWavInfo(out.bytes) : null;
          const timeline = wavInfo ? buildCharTimeFromQwenEstimate(out.bytes, v.body.text, wavInfo) : null;
          const timelineMeta = timeline ? {
            durationMs: Math.round(wavInfo.dataSize / (wavInfo.sampleRate * wavInfo.blockAlign / 1000)),
            active: timeline.active,
            chars: summarizeQwenTimeline(timeline, v.body.text),
            coverage: { covered: timeline.charTime.filter(Boolean).length, total: Array.from(v.body.text || '').length, sources: sourceCounts(timeline.sources), strategy: timeline.strategy },
            segments: timeline.segments,
            runs: timeline.runs,
          } : null;
          let clipHtml = '';
          let clipMeta = null;
          if (v.body.teaching_target && out.format === 'wav') {
            const targetWord = findTargetWord(out.words, v.body.teaching_target) || qwenEstimatedTargetWord(out.bytes, v.body.text, v.body.teaching_target);
            if (targetWord) {
              const clipped = cropWavByMs(out.bytes, targetWord.begin_time, targetWord.end_time, 140, 240, { minDurationMs: 520, tailSilenceToMs: 900 });
              let cbin = '';
              for (const b of clipped) cbin += String.fromCharCode(b);
              clipHtml = `<h4>裁切目标字</h4><audio controls src="data:audio/wav;base64,${btoa(cbin)}"></audio>`;
              clipMeta = { target: v.body.teaching_target, word: targetWord, bytes: clipped.length, audioDebug: getAudioDebug(clipped) };
            } else if (allowEnergyFallback) {
              const energyClip = cropFirstActiveWavSegment(out.bytes);
              let ebin = '';
              for (const b of energyClip.bytes) ebin += String.fromCharCode(b);
              clipHtml = `<h4>能量裁切实验（非有效单字）</h4><audio controls src="data:audio/wav;base64,${btoa(ebin)}"></audio>`;
              clipMeta = { target: v.body.teaching_target, error: 'target word timestamp not found', fallback: energyClip.range, bytes: energyClip.bytes.length, audioDebug: getAudioDebug(energyClip.bytes) };
            } else {
              clipMeta = { target: v.body.teaching_target, error: 'target word timestamp not found', fallback: 'disabled; add fallback=1 to inspect energy crop' };
            }
          }
          rows.push(`<section><h3>${escapeHtml(v.label)}</h3><h4>完整载体</h4><audio controls src="data:${mime};base64,${b64}"></audio>${clipHtml}<pre>${escapeHtml(JSON.stringify({ text, request: v.body, sentText: out.requestText, parameters: out.parameters, bytes: out.bytes.length, format: out.format, provider: out.provider, chunks: out.chunks, events: out.events, words: out.words, outputs: out.outputs, timeline: timelineMeta, clip: clipMeta, audioDebug: out.audioDebug, model: out.model, voice: out.voice, runAll, allowEnergyFallback }, null, 2))}</pre></section>`);
        } catch (e) {
          rows.push(`<section><h3>${escapeHtml(v.label)}</h3><pre class="err">${escapeHtml(JSON.stringify({ error: e.message, request: v.body }, null, 2))}</pre></section>`);
        }
      }
      const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qwen TTS 发音实测</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:880px;margin:28px auto;padding:0 16px;line-height:1.55;color:#1f2d3d}section{border:1px solid #dde4ef;border-radius:8px;padding:16px;margin:14px 0;background:#fff}audio{width:100%;margin:8px 0}pre{white-space:pre-wrap;background:#f6f8fb;padding:12px;border-radius:6px;overflow:auto}.err{color:#b42318;background:#fff1f0}input{padding:8px 10px;margin:0 8px 8px 0;border:1px solid #cfd8e3;border-radius:6px}button{padding:8px 12px;border:0;border-radius:6px;background:#3778c2;color:#fff}</style><h1>Qwen TTS 发音实测</h1><form method="get"><input name="text" value="${escapeAttr(text)}" placeholder="字/词"><input name="py" value="${escapeAttr(py)}" placeholder="普通话拼音"><input name="jp" value="${escapeAttr(jp)}" placeholder="粤拼"><input name="voice" value="${escapeAttr(debugVoice)}" placeholder="voice"><input name="model" value="${escapeAttr(debugModel)}" placeholder="model"><input name="instructions" value="${escapeAttr(debugInstructions)}" placeholder="instructions"><label><input type="checkbox" name="optimize_instructions" value="1" ${debugOptimizeInstructions ? 'checked' : ''}> optimize</label><button>生成</button></form><p>目标：默认只跑一组以节省费用。Qwen TTS 没有原生 words 时间戳，裁切使用整句音频的本地能量时间线；<code>instructions</code> 只在 Instruct 模型发送；加 <code>fallback=1</code> 可查看能量裁切实验。</p>${rows.join('')}`;
      return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/debug-preprocess') {
      if (!(await checkAuth(request, env))) {
        return new Response('Unauthorized', { status: 401 });
      }
      const text = url.searchParams.get('text') || '说，字。';
      const voice = normalizeQwenVoice(url.searchParams.get('voice') || env.QWEN_TTS_VOICE || QWEN_TTS_DEFAULT_VOICE);
      const model = normalizeQwenModel(url.searchParams.get('model') || env.QWEN_TTS_MODEL || QWEN_TTS_DEFAULT_MODEL);
      const languageType = url.searchParams.get('language_type') || env.QWEN_TTS_LANGUAGE_TYPE || 'Chinese';
      const target = String(url.searchParams.get('target') || '').trim();
      const targetIndexParam = url.searchParams.get('target_index');
      const targetIndex = targetIndexParam != null && targetIndexParam !== '' ? Number(targetIndexParam) : NaN;
      const targetOccurrence = Math.max(1, Number(url.searchParams.get('target_occurrence') || 1) || 1);
      const clipNumberParam = (name, fallback) => {
        const raw = url.searchParams.get(name);
        const value = raw == null || raw === '' ? fallback : Number(raw);
        return Number.isFinite(value) ? Math.max(0, value) : fallback;
      };
      const clipPadStartMs = clipNumberParam('clip_pad_start', 140);
      const clipPadEndMs = clipNumberParam('clip_pad_end', 240);
      const clipMinMs = clipNumberParam('clip_min_ms', 520);
      const clipTailMs = clipNumberParam('clip_tail_ms', 900);
      const instructions = String(url.searchParams.get('instructions') || '').trim();
      const optimizeInstructions = url.searchParams.get('optimize_instructions') === '1' || url.searchParams.get('optimize') === '1';
      let section = '';
      try {
        const pd = await preprocessTts(env, {
          text,
          voice,
          model,
          format: 'wav',
          sample_rate: 24000,
          language_type: languageType,
          instructions: instructions || undefined,
          optimize_instructions: optimizeInstructions,
        });
        const wavBytes = hexToBytes(pd.audio_hex);
        let bin = '';
        for (const b of wavBytes) bin += String.fromCharCode(b);
        const audioDebug = getAudioDebug(wavBytes);
        let clipHtml = '';
        let clip = null;
        if (target) {
          const chars = Array.from(pd.text || text || '');
          const targetChars = Array.from(target);
          const matches = [];
          for (let i = 0; i <= chars.length - targetChars.length; i++) {
            let ok = true;
            for (let j = 0; j < targetChars.length; j++) if (chars[i + j] !== targetChars[j]) ok = false;
            if (ok) matches.push(i);
          }
          let idx = -1;
          if (Number.isInteger(targetIndex)) {
            const fits = targetIndex >= 0 && targetIndex <= chars.length - targetChars.length && targetChars.every((ch, j) => chars[targetIndex + j] === ch);
            idx = fits ? targetIndex : -1;
          } else if (matches.length) {
            idx = matches[Math.min(matches.length - 1, targetOccurrence - 1)];
          }
          const first = idx >= 0 ? pd.char_time?.[idx] : null;
          const last = idx >= 0 ? pd.char_time?.[idx + targetChars.length - 1] : null;
          if (first && last && last[1] > first[0]) {
            const clipped = cropWavByMs(wavBytes, first[0], last[1], clipPadStartMs, clipPadEndMs, { minDurationMs: clipMinMs, tailSilenceToMs: clipTailMs });
            let cbin = '';
            for (const b of clipped) cbin += String.fromCharCode(b);
            clipHtml = `<h3>目标裁切：${escapeHtml(target)} @ ${idx}</h3><audio controls src="data:audio/wav;base64,${btoa(cbin)}"></audio>`;
            clip = { target, index: idx, requested_index: Number.isInteger(targetIndex) ? targetIndex : null, requested_occurrence: targetOccurrence, matches, begin_time: first[0], end_time: last[1], crop: { pad_start_ms: clipPadStartMs, pad_end_ms: clipPadEndMs, min_ms: clipMinMs, tail_ms: clipTailMs }, source: pd.char_source?.[idx] || '', group: pd.char_group?.[idx] || '', bytes: clipped.length, audioDebug: getAudioDebug(clipped) };
          } else {
            clip = { target, index: idx, requested_index: Number.isInteger(targetIndex) ? targetIndex : null, requested_occurrence: targetOccurrence, matches, crop: { pad_start_ms: clipPadStartMs, pad_end_ms: clipPadEndMs, min_ms: clipMinMs, tail_ms: clipTailMs }, error: 'target char_time not found' };
          }
        }
        const summary = {
          request: { text, target: target || undefined, target_index: Number.isInteger(targetIndex) ? targetIndex : undefined, target_occurrence: targetOccurrence, clip: { pad_start_ms: clipPadStartMs, pad_end_ms: clipPadEndMs, min_ms: clipMinMs, tail_ms: clipTailMs }, voice, model, language_type: languageType, instructions: instructions || undefined, optimize_instructions: optimizeInstructions },
          response: {
            text: pd.text,
            provider: pd.provider,
            voice: pd.voice,
            model: pd.model,
            request_text: pd.request_text,
            sr: pd.sr,
            ch: pd.ch,
            bits: pd.bits,
            data_off: pd.data_off,
            data_size: pd.data_size,
            char_count: pd.char_count,
            coverage: pd.coverage,
            parameters: pd.parameters,
            audioDebug,
            subtitle_debug: pd.subtitle_debug,
            char_time: pd.char_time,
            char_source: pd.char_source,
            char_group: pd.char_group,
            clip,
          },
        };
        section = `<section><h3>完整预处理音频</h3><audio controls src="data:audio/wav;base64,${btoa(bin)}"></audio>${clipHtml}<pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre></section>`;
      } catch (e) {
        section = `<section><pre class="err">${escapeHtml(JSON.stringify({ error: e.message, request: { text, target: target || undefined, target_index: Number.isInteger(targetIndex) ? targetIndex : undefined, target_occurrence: targetOccurrence, clip: { pad_start_ms: clipPadStartMs, pad_end_ms: clipPadEndMs, min_ms: clipMinMs, tail_ms: clipTailMs }, voice, model, language_type: languageType } }, null, 2))}</pre></section>`;
      }
      const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qwen 预处理时间线实测</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:980px;margin:28px auto;padding:0 16px;line-height:1.55;color:#1f2d3d}section{border:1px solid #dde4ef;border-radius:8px;padding:16px;margin:14px 0;background:#fff}audio{width:100%;margin:8px 0}pre{white-space:pre-wrap;background:#f6f8fb;padding:12px;border-radius:6px;overflow:auto}.err{color:#b42318;background:#fff1f0}input{padding:8px 10px;margin:0 8px 8px 0;border:1px solid #cfd8e3;border-radius:6px}button{padding:8px 12px;border:0;border-radius:6px;background:#3778c2;color:#fff}</style><h1>Qwen 预处理时间线实测</h1><form method="get"><input name="text" value="${escapeAttr(text)}" placeholder="整句/载体文本"><input name="target" value="${escapeAttr(target)}" placeholder="裁切目标"><input name="target_occurrence" value="${escapeAttr(targetOccurrence)}" placeholder="第几次出现"><input name="target_index" value="${Number.isInteger(targetIndex) ? escapeAttr(targetIndex) : ''}" placeholder="绝对下标"><input name="clip_pad_start" value="${escapeAttr(clipPadStartMs)}" placeholder="前垫ms"><input name="clip_pad_end" value="${escapeAttr(clipPadEndMs)}" placeholder="后垫ms"><input name="clip_min_ms" value="${escapeAttr(clipMinMs)}" placeholder="最短ms"><input name="clip_tail_ms" value="${escapeAttr(clipTailMs)}" placeholder="尾静音ms"><input name="voice" value="${escapeAttr(voice)}" placeholder="voice"><input name="model" value="${escapeAttr(model)}" placeholder="model"><input name="language_type" value="${escapeAttr(languageType)}" placeholder="language_type"><input name="instructions" value="${escapeAttr(instructions)}" placeholder="instructions"><label><input type="checkbox" name="optimize_instructions" value="1" ${optimizeInstructions ? 'checked' : ''}> optimize</label><button>生成</button></form><p>这里调用真实 <code>/preprocess</code> 主链路：Qwen 合成整句 WAV，再用本地能量时间线生成 <code>char_time</code>；填写 <code>target</code> 会直接按时间线裁切试听，重复字可用 <code>target_occurrence</code> 或 <code>target_index</code> 定位；裁切窗口可调 <code>clip_pad_start</code>/<code>clip_pad_end</code>/<code>clip_min_ms</code>/<code>clip_tail_ms</code>。</p>${section}`;
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

    // Qwen TTS 代理（单次请求，不再切分）
    if (url.pathname === '/tts') {
      if (request.method === 'HEAD') {
        return new Response(null, { status: (env.DASHSCOPE_API_KEY || env.QWEN_TTS_API_KEY || env.COSYVOICE_API_KEY || env.ALIYUN_API_KEY) ? 200 : 500 });
      }
      if (request.method === 'GET' || request.method === 'POST') {
        if (!(await checkAuth(request, env))) {
          return new Response('Unauthorized', { status: 401 });
        }
        try {
          const body = request.method === 'POST'
            ? await request.json()
            : { text: url.searchParams.get('text') || '', voice: url.searchParams.get('voice') || undefined, language_type: url.searchParams.get('language_type') || undefined };
          const out = await qwenTts(env, body);
          const audioFormat = out.format || body.format || 'wav';
          const contentType = audioFormat === 'wav' ? 'audio/wav' : (audioFormat === 'pcm' ? 'audio/L16' : (audioFormat === 'opus' ? 'audio/ogg' : 'audio/mpeg'));
          return new Response(out.bytes, {
            headers: {
              'Content-Type': contentType,
              'Cache-Control': 'public,max-age=31536000,immutable',
              'Content-Length': String(out.bytes.length),
              'X-Audio-Format': audioFormat,
              'X-TTS-Provider': 'qwen-tts',
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
