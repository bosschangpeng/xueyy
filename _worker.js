// Cloudflare Pages Worker — 粤语 TTS 代理
// 部署: 放在网站根目录，Cloudflare Pages 自动启用

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

    if (url.pathname === '/tts') {
      const text = url.searchParams.get('text');
      if (!text || text.length > 200) {
        return new Response('Bad request', { status: 400 });
      }

      for (const src of TTS_SOURCES) {
        try {
          const resp = await fetch(src.url(text), { headers: src.headers });
          if (!resp.ok) continue;

          const buf = await resp.arrayBuffer();
          return new Response(buf, {
            headers: {
              'Content-Type': resp.headers.get('Content-Type') || 'audio/mpeg',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=3600',
            },
          });
        } catch (e) {
          continue;
        }
      }

      return new Response('TTS unavailable', { status: 502 });
    }

    // 其他请求 — 返回 index.html (SPA)
    return new Response(null, { status: 404 });
  },
};
