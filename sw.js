// アプリ本体をキャッシュして、ホーム画面から素早く起動できるようにする
const CACHE = "nandakke-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "db.js", "ai.js", "manifest.json", "icon.svg"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener("activate", (e) =>
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))),
);

// 自分のファイルだけ「ネット優先・失敗したらキャッシュ」。API通信には触れない
self.addEventListener("fetch", (e) => {
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
