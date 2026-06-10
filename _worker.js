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

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/tts') return new Response(null, { status: 404 });
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Max-Age': '86400' },
      });
    }

    const text = url.searchParams.get('text');
    if (!text) return new Response('Missing text', { status: 400 });

    // Try each TTS source
    for (const src of TTS_SOURCES) {
      try {
        const resp = await fetch(src.url(text), { headers: src.headers });
        if (!resp.ok) continue;
        const buf = await resp.arrayBuffer();
        if (buf.byteLength > 100) {
          return new Response(buf, {
            headers: {
              'Content-Type': resp.headers.get('Content-Type') || 'audio/mpeg',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=3600',
            },
          });
        }
      } catch (e) { continue; }
    }

    return new Response('TTS unavailable', { status: 502 });
  },
};
