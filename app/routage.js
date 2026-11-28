// Routage camion avec Valhalla (moteur open source, données OpenStreetMap, sans clé).
// - matrice() : distances et durées routières entre tous les arrêts, pour le solveur.
// - trace()   : tracé exact sur la route, dans l'ordre de passage, pour la carte.
// Utilitaire (≤ 3,5 t) : profil « auto » de Valhalla avec la hauteur et la largeur du
// véhicule (ponts et passages bas évités), sans les interdictions poids lourd.
// Poids lourd : profil « truck » (hauteur, largeur, longueur, poids, interdits PL).

export const SERVEUR_DEFAUT = "https://valhalla1.openstreetmap.de";

export const VEHICULE_DEFAUT = Object.freeze({
  nom: "Fourgon 20 m³",
  type: "utilitaire", // "utilitaire" (≤ 3,5 t, permis B) ou "poids_lourd"
  hauteur: 3.4, // m : passe sous les ponts de 3,40 m et plus
  largeur: 2.2, // m, rétroviseurs repliés
  longueur: 7, // m
  poids: 3.5, // t, poids total autorisé en charge
  volume: 20, // m³ (pour information)
});

export const poidsLourd = (v) => v.type === "poids_lourd";

// Limites du serveur public FOSSGIS, relevées le 28/11/2026 :
// 10 lieux par itinéraire, 100 couples départ × arrivée par requête de matrice.
const MAX_LIEUX_ITINERAIRE = 10;
const MAX_COUPLES_MATRICE = 100;
const EN_PARALLELE = 2;

const nombre = (x) => String(x).replace(".", ",");

export function resumeVehicule(v) {
  return [v.nom || "Véhicule", poidsLourd(v) ? "poids lourd" : "utilitaire", `${nombre((+v.hauteur).toFixed(2))} m de haut`, `${nombre(v.poids)} t`].join(" · ");
}

const costing = (v) => (poidsLourd(v) ? "truck" : "auto");
function options(v) {
  if (!poidsLourd(v)) return { auto: { height: +v.hauteur, width: +v.largeur } };
  return { truck: { height: +v.hauteur, width: +v.largeur, length: +v.longueur, weight: +v.poids, hazmat: false } };
}

const base = (serveur) => (serveur || SERVEUR_DEFAUT).replace(/\/+$/, "");

async function post(serveur, chemin, corps, signal) {
  for (let essai = 0; ; essai++) {
    let r;
    try {
      r = await fetch(base(serveur) + chemin, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps), signal });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (essai < 2) { await pause(1500 * (essai + 1)); continue; }
      throw new Error("serveur de routage injoignable");
    }
    if ((r.status === 429 || r.status >= 500) && essai < 3) { await pause(2000 * (essai + 1)); continue; }
    let j = null;
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const err = new Error((j && (j.error || j.status)) || "HTTP " + r.status);
      err.code = j && j.error_code; err.http = r.status;
      throw err;
    }
    return j;
  }
}
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function enParallele(taches, n) {
  const res = new Array(taches.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, taches.length) }, async () => {
    while (k < taches.length) { const i = k++; res[i] = await taches[i](); }
  }));
  return res;
}

/** Clé d'une matrice : change si un lieu bouge, si le véhicule ou le serveur change. */
export function cleMatrice(serveur, v, lieux) {
  return JSON.stringify([base(serveur), options(v), lieux.map((l) => [l.id, l.lat.toFixed(6), l.lon.toFixed(6)])]);
}

/**
 * Matrice routière camion entre `lieux` ([{id, lat, lon}], le dépôt en premier).
 * Renvoie { ids, distances (m), durees (s) } ; null quand aucun trajet n'existe pour ce véhicule.
 */
export async function matrice(serveur, v, lieux, progression = () => {}, signal) {
  const n = lieux.length;
  const loc = lieux.map((l) => ({ lat: l.lat, lon: l.lon }));
  const cols = Math.min(n, MAX_COUPLES_MATRICE);
  const lignes = Math.max(1, Math.floor(MAX_COUPLES_MATRICE / cols));
  const distances = Array.from({ length: n }, () => new Array(n).fill(null));
  const durees = Array.from({ length: n }, () => new Array(n).fill(null));
  const taches = [];
  let faites = 0;
  for (let i = 0; i < n; i += lignes) {
    for (let j = 0; j < n; j += cols) {
      taches.push(async () => {
        const src = loc.slice(i, i + lignes), dst = loc.slice(j, j + cols);
        const r = await post(serveur, "/sources_to_targets", { sources: src, targets: dst, costing: costing(v), costing_options: options(v), units: "kilometers" }, signal);
        (r.sources_to_targets || []).forEach((ligne, a) => ligne.forEach((c, b) => {
          const x = i + (c.from_index ?? a), y = j + (c.to_index ?? b);
          if (c.distance != null && c.time != null) { distances[x][y] = c.distance * 1000; durees[x][y] = c.time; }
        }));
        progression(++faites, taches.length);
      });
    }
  }
  await enParallele(taches, EN_PARALLELE);
  for (let i = 0; i < n; i++) { distances[i][i] = 0; durees[i][i] = 0; }
  return { ids: lieux.map((l) => l.id), distances, durees };
}

/** Décode une polyligne Valhalla (précision 6) en [[lat, lon], …]. */
export function decoder(str, precision = 6) {
  const f = 10 ** precision, pts = [];
  let i = 0, lat = 0, lon = 0;
  const lire = () => { let r = 0, s = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < str.length) { lat += lire(); lon += lire(); pts.push([lat / f, lon / f]); }
  return pts;
}

async function itineraire(serveur, v, lieux, signal) {
  const r = await post(serveur, "/route", {
    locations: lieux.map((l) => ({ lat: l.lat, lon: l.lon, type: "break" })),
    costing: costing(v), costing_options: options(v), units: "kilometers", directions_type: "none",
  }, signal);
  return r.trip.legs.map((l) => ({ km: l.summary.length, min: l.summary.time / 60, shape: decoder(l.shape), route: true }));
}

/**
 * Tracé sur la route de la séquence `seq` ([{lat, lon}], dépôt au début et à la fin).
 * Renvoie un tronçon par trajet : { km, min, shape, route }. Un tronçon sans chemin
 * possible pour le camion est tracé en ligne droite avec route = false.
 */
export async function trace(serveur, v, seq, signal) {
  const blocs = [];
  for (let s = 0; s + 1 < seq.length; s += MAX_LIEUX_ITINERAIRE - 1) blocs.push(seq.slice(s, Math.min(s + MAX_LIEUX_ITINERAIRE, seq.length)));
  const parBloc = await enParallele(blocs.map((b) => async () => {
    try { return await itineraire(serveur, v, b, signal); } catch (e) {
      if (e.http !== 400) throw e; // pas de chemin sur ce bloc : trajet par trajet
      const out = [];
      for (let k = 0; k + 1 < b.length; k++) {
        try { out.push(...(await itineraire(serveur, v, [b[k], b[k + 1]], signal))); }
        catch (e2) { if (e2.http !== 400) throw e2; out.push({ km: null, min: null, shape: [[b[k].lat, b[k].lon], [b[k + 1].lat, b[k + 1].lon]], route: false }); }
      }
      return out;
    }
  }), EN_PARALLELE);
  return parBloc.flat().map((l) => ({ ...l, shape: l.shape.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]) }));
}
