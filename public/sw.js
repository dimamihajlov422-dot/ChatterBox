// ============================================================
// ChatterBox Service Worker
// Отвечает за показ push-уведомлений, даже когда вкладка/приложение
// полностью закрыты. Работает только по HTTPS (или на localhost).
// ============================================================

self.addEventListener("install", (event) => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
    let data = { title: "ChatterBox", body: "Новое сообщение" };
    try {
        if (event.data) data = event.data.json();
    } catch (e) {
        if (event.data) data.body = event.data.text();
    }

    const options = {
        body: data.body || "",
        icon: "/images/icon-192.png",
        badge: "/images/icon-192.png",
        tag: data.tag || "chatterbox",
        renotify: true,
        vibrate: [100, 50, 100],
        data: { url: "/" }
    };

    event.waitUntil(self.registration.showNotification(data.title || "ChatterBox", options));
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
            for (const client of clientsArr) {
                if ("focus" in client) return client.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow("/");
        })
    );
});
