// sw.js
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open('chatterbox-v1').then((cache) => {
            return cache.addAll([
                '/',
                '/index.html',
                '/images/bg.jpg',
                '/images/db2.jpg'
            ]);
        })
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((response) => {
            return response || fetch(e.request);
        })
    );
});

self.addEventListener('push', (e) => {
    const data = e.data ? e.data.json() : {};
    const title = data.title || 'ChatterBox';
    const options = {
        body: data.body || 'Новое сообщение',
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        vibrate: [200, 100, 200],
        data: data.data || {},
        actions: [
            { action: 'open', title: 'Открыть' }
        ]
    };
    e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    if (e.action === 'open' || !e.action) {
        e.waitUntil(clients.matchAll({ type: 'window' }).then((clientsArr) => {
            if (clientsArr.length > 0) {
                clientsArr[0].focus();
            } else {
                clients.openWindow('/');
            }
        }));
    }
});
