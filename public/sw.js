/* Leco Shop · Service Worker
 * Regra de ouro: NUNCA guardar dados de venda em cache.
 * Só a "casca" do app (HTML/ícones) fica salva, para abrir rápido e funcionar
 * mesmo sem internet. Tudo que é /api/ vai sempre buscar no servidor.
 */
const CACHE = 'leco-shop-v1';
const CASCA = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCA).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // ex.: fotos do ML
  if (url.pathname.startsWith('/api/')) return;                // dados: sempre ao vivo
  if (url.pathname.startsWith('/auth/') || url.pathname === '/callback') return;

  // Casca: tenta a rede primeiro (para receber atualizações),
  // e usa o cache só se a internet falhar.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('/')))
  );
});
