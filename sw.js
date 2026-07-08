// ============================================================
// KAKULE — Service Worker (PWA)
// ============================================================
// Güncelleme stratejisi:
//   - Uygulama dosyaları (html/js/css/manifest) için "network-first":
//     çevrimiçiyken her zaman en güncel sürüm indirilir, çevrimdışıyken
//     önbellekten servis edilir. Böylece app.js/style.css'i her
//     güncellediğinizde kullanıcılar eski sürümde kalmaz.
//   - Diğer aynı-köken istekleri için "cache-first" (hızlı açılış).
//   - Firebase/Google/Cloudinary gibi dış isteklere hiç dokunulmaz.
//
// NOT: Uygulama dosyalarını her güncellediğinizde CACHE_SURUM değerini
// artırın (v2 -> v3 ...). Bu, eski önbelleğin otomatik temizlenmesini
// ve yeni Service Worker'ın devreye girmesini garanti eder.
// ============================================================

const CACHE_SURUM = "kakule-v4";
const CORE_ASSETS = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json"
];

// Bu yolların (sonu bu şekilde biten aynı-köken istekleri) network-first
// ile taze tutulması hedeflenir.
function uygulamaDosyasiMi(url) {
  const yol = url.pathname;
  return (
    yol.endsWith("/") ||
    yol.endsWith("/index.html") ||
    yol.endsWith("/app.js") ||
    yol.endsWith("/style.css") ||
    yol.endsWith("/manifest.json")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_SURUM).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_SURUM).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ============================================================
// PUSH BİLDİRİMİ (uygulama tamamen kapalıyken de çalışır)
// ============================================================
self.addEventListener("push", (event) => {
  let veri = {};
  try { veri = event.data ? event.data.json() : {}; } catch { veri = {}; }

  const baslik = veri.title || "Kakule";
  const secenekler = {
    body: veri.body || "Yeni mesaj",
    icon: veri.icon || "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: veri.tag || "kakule-mesaj",
    data: { url: veri.url || "./" }
  };

  event.waitUntil(self.registration.showNotification(baslik, secenekler));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const hedefUrl = event.notification.data?.url || "./";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(hedefUrl);
    })
  );
});

// ============================================================
// FETCH — network-first (uygulama dosyaları) / cache-first (diğer)
// ============================================================
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Sadece kendi kökenimiz; Firebase/Google/Cloudinary isteklerine dokunma.
  if (url.origin !== self.location.origin) return;

  // Uygulama dosyaları: önce ağ, başarısızsa önbellek (taze kalsın).
  if (event.request.mode === "navigate" || uygulamaDosyasiMi(url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_SURUM).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request).then((cached) => cached || caches.match("./index.html"))
        )
    );
    return;
  }

  // Diğer aynı-köken varlıklar: önce önbellek (hız), yoksa ağdan çek ve sakla.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_SURUM).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached)
      );
    })
  );
});
