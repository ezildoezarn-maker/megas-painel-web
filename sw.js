// Service worker do Painel Megas Express: recebe as notificações push
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch (e) {
    dados = { title: 'Megas Express', body: event.data ? event.data.text() : '' };
  }
  const opcoes = {
    body: dados.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: '/index.html' }
  };
  if (dados.tag) { opcoes.tag = dados.tag; opcoes.renotify = true; }
  event.waitUntil(self.registration.showNotification(dados.title || 'Megas Express', opcoes));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const c of lista) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow('/index.html');
    })
  );
});
