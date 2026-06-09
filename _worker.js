// Cloudflare Pages Worker — 粤语 TTS 代理
// 自动分段拼接，无长度限制

const TTS_SOURCES = [
  {
    name: 'youdao',
    url: (t) => `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(t)}&type=2`,
    headers: { 'Referer': 'https://dict.youdao.com/' },
  },
  {
    name: 'baidu',
    url: (t) => `https://fanyi.baidu.com/gettts?lan=yue&text=${encodeURIComponent(t)}&spd=5&source=web`,
    headers: { 'Referer': 'https://fanyi.baidu.com/' },
  },
];

const CHUNK_MAX = 150;

function splitText(text) {
  const parts = []; let cur = '';
  for (const ch of text) {
    if (/[。！？，、；：.!?,\n\r]/.test(ch) && cur.length > 5) { cur += ch; parts.push(cur); cur = ''; }
    else if (cur.length >= CHUNK_MAX) { parts.push(cur); cur = ch; }
    else { cur += ch; }
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [text];
}

async function fetchOne(text) {
  for (const src of TTS_SOURCES) {
    try {
      const resp = await fetch(src.url(text), { headers: src.headers });
      if (!resp.ok) continue;
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > 100) return buf;
    } catch (e) { continue; }
  }
  return null;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/tts') return new Response(null, { status: 404 });

    const text = url.searchParams.get('text');
    if (!text) return new Response('Missing text', { status: 400 });

    const chunks = splitText(text);
    const audioBufs = [];

    for (const chunk of chunks) {
      const buf = await fetchOne(chunk);
      if (buf) audioBufs.push(buf);
    }

    if (!audioBufs.length) return new Response('TTS unavailable', { status: 502 });

    const total = audioBufs.reduce((s, b) => s + b.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const buf of audioBufs) {
      merged.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }

    return new Response(merged, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  },
};
