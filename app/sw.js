// Garde l'appli disponible hors connexion (sauf la recherche d'adresses et la carte).
const CACHE = "tournee-pav-v1";
const FICHIERS = [
  "./", "index.html", "app.js", "manifest.webmanifest", "icone.svg",
  "pkg/tournee_wasm.js", "pkg/tournee_wasm_bg.wasm",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css",
  "vendor/pdfjs/pdf.min.js", "vendor/pdfjs/pdf.worker.min.js",
  "vendor/tesseract/tesseract.min.js", "vendor/tesseract/worker.min.js",
  "vendor/tesseract/lang/fra.traineddata",
];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return; // BAN, carte : réseau
  // Réseau d'abord pour avoir la dernière version, cache si hors connexion.
  e.respondWith(
    fetch(e.request).then((r) => { const copie = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copie)); return r; })
      .catch(() => caches.match(e.request))
  );
});
