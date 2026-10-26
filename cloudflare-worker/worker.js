// Посредник для CurseForge: хранит ключ разработчика в секрете Cloudflare и пересылает только нужные запросы.
// Ключ добавляется в настройках воркера: Settings → Variables and Secrets → Add → тип Secret, имя CF_API_KEY.
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const allowed = /^\/v1\/mods\/(search|\d{1,9}(\/files|\/description)?)$/.test(u.pathname);
    if (req.method !== 'GET' || !allowed || !env.CF_API_KEY) return new Response('Not found', { status: 404 });
    const cache = caches.default;
    const hit = await cache.match(req);
    if (hit) return hit;
    const r = await fetch('https://api.curseforge.com' + u.pathname + u.search, { headers: { 'x-api-key': env.CF_API_KEY, Accept: 'application/json' } });
    const res = new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
    if (r.ok) await cache.put(req, res.clone());
    return res;
  }
};
