// Tournée PAV : appli tout embarquée.
// Le moteur Rust (pkg/, WebAssembly) lit les fiches, calcule la tournée et produit l'Excel.
// pdf.js lit les PDF, Tesseract.js fait l'OCR des photos : tout tourne sur l'appareil.
// Le placement des adresses interroge la Base Adresse Nationale (service public, sans clé).
// Les distances routières et le tracé du camion viennent de Valhalla (open source, sans clé).

import init, * as moteur from "./pkg/tournee_wasm.js";
import * as routage from "./routage.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const KEY = "tournee-pav-app-v1";
const uid = () => Math.random().toString(36).slice(2, 9);
const SCORE_FIABLE = 0.6;
const GEOCODEURS = ["https://data.geopf.fr/geocodage/search", "https://api-adresse.data.gouv.fr/search/"];

let S = { depot: { adresse: "", lat: null, lon: null }, date: "", points: [], tournee: null, vehicule: { ...routage.VEHICULE_DEFAUT }, serveurRoutage: "" };
// Dernière matrice routière calculée (gardée à part : elle peut être grosse).
let M = { cle: "", m: null };
function chargerMatrice() { try { const x = JSON.parse(localStorage.getItem(KEY + "-matrice") || "null"); if (x && x.cle) M = x; } catch (e) {} }
function garderMatrice() { try { localStorage.setItem(KEY + "-matrice", JSON.stringify(M)); } catch (e) {} }
let fichiers = [];
let pret = false;

/* ---------------- état ---------------- */
function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s) S = Object.assign(S, s); } catch (e) {}
  S.vehicule = { ...routage.VEHICULE_DEFAUT, ...(S.vehicule || {}) };
  chargerMatrice();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
function parseGps(s) { const m = String(s || "").match(/(-?\d{1,2}[.,]\d+)\s*[,; ]\s*(-?\d{1,3}[.,]\d+)/); return m ? { lat: +m[1].replace(",", "."), lon: +m[2].replace(",", ".") } : null; }
const pos = (p) => p && typeof p.lat === "number" && typeof p.lon === "number";
const fmt = (p) => (pos(p) ? p.lat.toFixed(5) + ", " + p.lon.toFixed(5) : "");
const km = (x) => x.toFixed(1).replace(".", ",");
const dureeTxt = (min) => { const m = Math.round(min); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`; };
function depotCourant() { return { adresse: S.depot.adresse || fmt(S.depot), lat: S.depot.lat, lon: S.depot.lon }; }
function statut(id, txt, err) { $(id).textContent = txt; $(id).className = "status" + (err ? " err" : ""); }

/* ---------------- lecture des fichiers ---------------- */
function typeDe(f) {
  const n = f.name.toLowerCase();
  if (f.type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (/\.(xlsx|xlsm|xls|xlsb|ods)$/.test(n)) return "classeur";
  if (n.endsWith(".csv") || f.type === "text/csv") return "csv";
  if (/\.(heic|heif)$/.test(n)) return "heic";
  return "image";
}

let ocrWorker = null;
async function ocr(image, progression) { return (await ocrDetail(image, progression)).texte; }
/** Texte lu + confiance moyenne de Tesseract (0-100). Une photo à l'envers ou de travers donne une confiance basse. */
async function ocrDetail(image, progression = () => {}) {
  if (!ocrWorker) {
    progression("préparation de l'OCR");
    ocrWorker = await Tesseract.createWorker("fra", 1, {
      workerPath: new URL("vendor/tesseract/worker.min.js", location.href).href,
      corePath: new URL("vendor/tesseract/core/", location.href).href,
      langPath: new URL("vendor/tesseract/lang/", location.href).href,
      gzip: false,
      cacheMethod: "none",
    });
    await ocrWorker.setParameters({ tessedit_pageseg_mode: "4", preserve_interword_spaces: "1" });
  }
  const r = await ocrWorker.recognize(image);
  return { texte: r.data.text, conf: r.data.confidence || 0 };
}

/** Texte d'un PDF en gardant les colonnes : les blocs éloignés sont séparés par plusieurs espaces. */
async function textePdf(buf, progression) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.js", location.href).href;
  const doc = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 40); i++) {
    progression(`page ${i}/${doc.numPages}`);
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items = tc.items.filter((it) => it.str !== undefined);
    if (items.map((x) => x.str).join("").replace(/\W/g, "").length < 20) {
      // Page scannée : on la rend en image et on fait l'OCR.
      const vp = page.getViewport({ scale: 2.5 });
      const cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height;
      const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      progression(`OCR page ${i}`);
      pages.push(await ocr(cv, progression));
      continue;
    }
    // Regroupe par ligne (même y), puis trie par x.
    const lignes = new Map();
    for (const it of items) {
      const y = Math.round(it.transform[5] / 3);
      if (!lignes.has(y)) lignes.set(y, []);
      lignes.get(y).push(it);
    }
    const ys = [...lignes.keys()].sort((a, b) => b - a);
    const out = [];
    for (const y of ys) {
      const its = lignes.get(y).sort((a, b) => a.transform[4] - b.transform[4]);
      let l = "", fin = null;
      for (const it of its) {
        const x = it.transform[4];
        const h = Math.abs(it.transform[3]) || 10;
        if (fin !== null) {
          const ecart = x - fin;
          l += ecart > h * 1.2 ? "   " : ecart > h * 0.15 ? " " : "";
        }
        l += it.str;
        fin = x + (it.width || 0);
      }
      out.push(l);
    }
    pages.push(out.join("\n"));
  }
  return { texte: pages.join("\n"), methode: "pdf" };
}

/** Image prête pour l'OCR : réduite à 2600 px, pivotée de `rot` degrés, en niveaux de gris contrastés. */
async function imagePourOcr(f, rot = 0) {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("image illisible")); i.src = url; });
    const max = 2600, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * sc), h = Math.round(img.naturalHeight * sc);
    const rendre = (deg) => {
      const a = (deg * Math.PI) / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
      const cv = document.createElement("canvas"); cv.width = Math.round(w * c + h * sn); cv.height = Math.round(w * sn + h * c);
      const cx = cv.getContext("2d", { willReadFrequently: true }); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
      cx.translate(cv.width / 2, cv.height / 2); cx.rotate(a); cx.drawImage(img, -w / 2, -h / 2, w, h);
      contraste(cx, cv.width, cv.height);
      return cv;
    };
    const cv = rendre(rot);
    // Redresse une photo légèrement penchée (jusqu'à ±8°).
    const penche = inclinaison(cv);
    return Math.abs(penche) >= 0.5 ? rendre(rot - penche) : cv;
  } finally { URL.revokeObjectURL(url); }
}
/** Estime l'inclinaison des lignes de texte (en degrés) : l'angle qui rend les lignes les plus nettes
    quand on additionne les pixels sombres ligne par ligne (méthode des profils de projection). */
function inclinaison(src) {
  const W = 500, k = W / src.width, H = Math.max(1, Math.round(src.height * k));
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const cx = c.getContext("2d", { willReadFrequently: true }); cx.drawImage(src, 0, 0, W, H);
  const px = cx.getImageData(0, 0, W, H).data, xs = [], ys = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4] < 110) { xs.push(x - W / 2); ys.push(y); }
  if (xs.length < 200) return 0;
  const note = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180), off = W, bins = new Float64Array(H + 2 * off);
    for (let i = 0; i < xs.length; i++) bins[Math.round(ys[i] - xs[i] * t) + off]++;
    let s = 0; for (let i = 1; i < bins.length; i++) { const d = bins[i] - bins[i - 1]; s += d * d; }
    return s;
  };
  let best = 0, bestNote = note(0);
  for (let d = -8; d <= 8; d += 0.5) { if (!d) continue; const n = note(d); if (n > bestNote * 1.02) { bestNote = n; best = d; } }
  // Affinage autour du meilleur angle.
  for (let d = best - 0.4; d <= best + 0.4; d += 0.2) { const n = note(d); if (n > bestNote) { bestNote = n; best = d; } }
  return Math.round(best * 10) / 10;
}
/** Niveaux de gris + étirement des niveaux (photo sombre ou délavée). */
function contraste(cx, w, h) {
  const d = cx.getImageData(0, 0, w, h), px = d.data, hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) { const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0; px[i] = g; hist[g]++; }
  const n = px.length / 4; let lo = 0, hi = 255, c = 0;
  while (lo < 255 && (c += hist[lo]) < n * 0.01) lo++;
  c = 0; while (hi > 0 && (c += hist[hi]) < n * 0.01) hi--;
  const k = hi > lo + 20 ? 255 / (hi - lo) : 1, b = hi > lo + 20 ? lo : 0;
  for (let i = 0; i < px.length; i += 4) { const v = Math.max(0, Math.min(255, (px[i] - b) * k)); px[i] = px[i + 1] = px[i + 2] = v; }
  cx.putImageData(d, 0, 0);
}

/* Lit un fichier. Pour une photo sans adresse reconnue, on réessaie automatiquement
   en la pivotant (photo prise de travers ou à l'envers). */
async function lireFichier(f, progression, rot = 0, manuel = false) {
  const t = typeDe(f);
  if (t === "heic") throw new Error("Format HEIC : réglez l'appareil photo en « Le plus compatible » (JPEG).");
  if (t === "classeur") return { points: JSON.parse(moteur.lire_classeur(new Uint8Array(await f.arrayBuffer()), f.name)), texte: "", methode: "Excel" };
  if (t === "csv") return { points: JSON.parse(moteur.lire_csv(await f.text(), f.name)), texte: "", methode: "CSV" };
  if (t === "pdf") { const { texte } = await textePdf(await f.arrayBuffer(), progression); return { points: JSON.parse(moteur.analyser_texte(texte, f.name)), texte, methode: "PDF" }; }
  // Lecture dans le sens actuel. Si elle est douteuse (aucune adresse ou confiance faible),
  // on essaie les 3 autres sens et on garde le meilleur. Une rotation choisie à la main est respectée.
  const essais = manuel ? [rot] : [rot, (rot + 90) % 360, (rot + 270) % 360, (rot + 180) % 360];
  const note = (x) => x.conf + 12 * Math.min(x.points.length, 5);
  let meilleur = null;
  for (const [i, r] of essais.entries()) {
    progression(i === 0 ? "OCR" : `OCR, essai ${i + 1}/4 en tournant la photo`);
    const { texte, conf } = await ocrDetail(await imagePourOcr(f, r), progression);
    const points = JSON.parse(moteur.analyser_texte(texte, f.name));
    const res = { points, texte, conf, rot: r, methode: r === rot ? "OCR" : "OCR, photo redressée" };
    if (!meilleur || note(res) > note(meilleur)) meilleur = res;
    if (points.length && conf >= (i === 0 ? 65 : 75)) break;
  }
  return meilleur;
}

/* ---------------- géocodage (BAN) ---------------- */
async function chercher(q, pres) {
  let derniere = "";
  for (const base of GEOCODEURS) {
    const u = new URL(base);
    u.searchParams.set("q", q.slice(0, 200)); u.searchParams.set("limit", "1");
    if (base.includes("geopf")) u.searchParams.set("index", "address");
    if (pres) { u.searchParams.set("lat", pres.lat.toFixed(5)); u.searchParams.set("lon", pres.lon.toFixed(5)); }
    for (let essai = 0; essai < 3; essai++) {
      try {
        const r = await fetch(u);
        if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 800 * (essai + 1))); continue; }
        if (!r.ok) { derniere = "HTTP " + r.status; break; }
        const j = await r.json(); const f = (j.features || [])[0];
        if (!f) return null;
        return { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], label: f.properties.label || "", score: f.properties.score ?? 0 };
      } catch (e) { derniere = e.message; break; }
    }
  }
  throw new Error("Recherche d'adresses impossible (" + (derniere || "réseau") + "). Vérifiez la connexion Internet.");
}
function haversine(a, b) { const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r; const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); }
const requete = (p) => [p.adresse, [p.code_postal, p.commune].filter(Boolean).join(" ")].filter(Boolean).join(", ");

async function placer() {
  statut("placerSt", "Recherche des adresses…");
  try {
    S.points = JSON.parse(moteur.fusionner(JSON.stringify(S.points)));
    const d = depotCourant();
    if (!pos(d) && d.adresse) {
      const r = await chercher(d.adresse, null);
      if (!r) throw new Error("Dépôt introuvable : " + d.adresse);
      S.depot.lat = r.lat; S.depot.lon = r.lon;
    }
    const pres = pos(depotCourant()) ? depotCourant() : null;
    let n = 0;
    const aPlacer = S.points.filter((p) => !pos(p) && p.origine !== "introuvable" && requete(p).length >= 3);
    for (const [i, p] of aPlacer.entries()) {
      statut("placerSt", `Recherche des adresses ${i + 1}/${aPlacer.length}…`);
      const r = await chercher(requete(p), pres);
      if (!r) { p.origine = "introuvable"; continue; }
      p.label = r.label; p.origine = "ban";
      if (pres && haversine(pres, r) > 80) { p.score = 0; p.label += " (à plus de 80 km du dépôt)"; continue; }
      p.lat = r.lat; p.lon = r.lon; p.score = r.score; n++;
    }
    save(); renderPoints();
    const faibles = S.points.filter((p) => p.origine === "ban" && p.score < SCORE_FIABLE).length;
    const ko = S.points.filter((p) => !pos(p)).length;
    statut("placerSt", `${n} adresse(s) placée(s).` + (faibles ? ` ${faibles} peu fiable(s).` : "") + (ko ? ` ${ko} sans position.` : ""));
  } catch (e) { statut("placerSt", e.message, true); save(); renderPoints(); }
}

/* ---------------- dépôt ---------------- */
function fillDepot() {
  $("date").value = S.date || "";
  const vide = !S.depot.adresse && !pos(S.depot);
  $("depotCard").classList.toggle("vide", vide);
  $("depotNom").textContent = vide ? "Pas encore réglé" : (S.depot.adresse || "Position GPS");
  $("depotGpsTxt").textContent = pos(S.depot) ? "GPS " + fmt(S.depot) : (vide ? "" : "Position cherchée au calcul");
}

/* Fenêtre de réglage du dépôt : suggestions pendant la saisie.
   Entreprises et lieux : Photon (OpenStreetMap, open source, sans clé).
   Adresses : Base Adresse Nationale (autocomplétion). */
const PHOTON = "https://photon.komoot.io/api/";
let choix = null, suggs = [], actif = -1, ctrl = null, minuterie = null, cfgCarte = null, cfgMarq = null;

function ligneAdresse(pr) {
  const rue = [pr.housenumber, pr.street].filter(Boolean).join(" ");
  const ville = [pr.postcode, pr.city || pr.town || pr.village || pr.locality].filter(Boolean).join(" ");
  return [rue, ville].filter(Boolean).join(", ");
}
async function sugPhoton(q, signal) {
  const u = new URL(PHOTON);
  u.searchParams.set("q", q); u.searchParams.set("lang", "fr"); u.searchParams.set("limit", "8");
  if (pos(S.depot)) { u.searchParams.set("lat", S.depot.lat); u.searchParams.set("lon", S.depot.lon); }
  else { u.searchParams.set("lat", "46.6"); u.searchParams.set("lon", "2.4"); u.searchParams.set("location_bias_scale", "0.1"); }
  const r = await fetch(u, { signal }); if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return (j.features || []).filter((f) => (f.properties.countrycode || "FR") === "FR").map((f) => {
    const pr = f.properties, adr = ligneAdresse(pr);
    const lieu = pr.name && !["street", "city", "district", "locality", "county", "state"].includes(pr.type) && !["highway", "place", "boundary"].includes(pr.osm_key);
    const titre = lieu ? pr.name : (adr || pr.name || "");
    const sous = lieu ? adr : [pr.county, pr.state].filter(Boolean).join(", ");
    return { lieu, titre, sous, label: lieu ? [pr.name, adr].filter(Boolean).join(", ") : titre, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
  }).filter((x) => x.titre);
}
async function sugBan(q, signal) {
  for (const base of GEOCODEURS) {
    try {
      const u = new URL(base);
      u.searchParams.set("q", q.slice(0, 200)); u.searchParams.set("limit", "5"); u.searchParams.set("autocomplete", "1");
      if (base.includes("geopf")) u.searchParams.set("index", "address");
      const r = await fetch(u, { signal }); if (!r.ok) continue;
      const j = await r.json();
      return (j.features || []).map((f) => ({ lieu: false, titre: f.properties.name || f.properties.label, sous: [f.properties.postcode, f.properties.city].filter(Boolean).join(" "), label: f.properties.label, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
    } catch (e) { if (e.name === "AbortError") throw e; }
  }
  return [];
}
async function suggerer(q) {
  if (ctrl) ctrl.abort();
  ctrl = new AbortController(); const signal = ctrl.signal;
  statut("cfgSt", "Recherche…");
  const [a, b] = await Promise.allSettled([sugPhoton(q, signal), q.length >= 3 ? sugBan(q, signal) : Promise.resolve([])]);
  if (signal.aborted) return;
  const ph = a.status === "fulfilled" ? a.value : [], ban = b.status === "fulfilled" ? b.value : [];
  const vus = new Set(), liste = [];
  for (const x of [...ph.filter((x) => x.lieu), ...ban, ...ph.filter((x) => !x.lieu)]) {
    const k = x.lat.toFixed(4) + "," + x.lon.toFixed(4) + "|" + x.titre.toLowerCase();
    if (vus.has(k)) continue; vus.add(k); liste.push(x);
  }
  suggs = liste.slice(0, 8); actif = -1;
  if (a.status === "rejected" && b.status === "rejected") statut("cfgSt", "Recherche impossible : vérifiez la connexion Internet.", true);
  else statut("cfgSt", "");
  afficherSuggs(true);
}
function afficherSuggs(apresRecherche) {
  const ul = $("cfgSugg");
  if (!suggs.length) {
    ul.innerHTML = apresRecherche ? `<li class="info">Aucun résultat. Essayez l'adresse (rue, commune), votre position actuelle, ou collez un lien Google Maps plus bas.</li>` : "";
  } else {
    ul.innerHTML = suggs.map((x, i) => `<li role="option" id="sg${i}" data-i="${i}" aria-selected="${i === actif}"><span class="ic">${x.lieu ? "🏢" : "📍"}</span><span><b>${esc(x.titre)}</b><small>${esc(x.sous)}</small></span></li>`).join("");
  }
  ul.hidden = !ul.innerHTML; $("cfgQ").setAttribute("aria-expanded", String(!ul.hidden));
  if (actif >= 0) $("cfgQ").setAttribute("aria-activedescendant", "sg" + actif); else $("cfgQ").removeAttribute("aria-activedescendant");
}
function montrerChoix() {
  $("cfgOk").disabled = !choix;
  $("cfgChoix").textContent = choix ? "Dépôt choisi : " + choix.adresse + " (GPS " + fmt(choix) + "). Vous pouvez déplacer le repère sur la carte." : "";
  if (!choix || typeof L === "undefined") return;
  $("cfgMap").classList.add("on");
  if (!cfgCarte) {
    cfgCarte = L.map("cfgMap", { zoomControl: true, attributionControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(cfgCarte);
  }
  cfgCarte.setView([choix.lat, choix.lon], 16);
  if (cfgMarq) cfgMarq.remove();
  cfgMarq = L.marker([choix.lat, choix.lon], { draggable: true }).addTo(cfgCarte);
  cfgMarq.on("dragend", () => { const g = cfgMarq.getLatLng(); choix.lat = g.lat; choix.lon = g.lng; montrerChoix(); });
  setTimeout(() => cfgCarte.invalidateSize(), 50);
}
function choisir(x) {
  choix = { adresse: x.label, lat: x.lat, lon: x.lon };
  $("cfgQ").value = x.label; suggs = []; afficherSuggs(false); montrerChoix();
}
async function inverse(lat, lon) {
  for (const base of ["https://data.geopf.fr/geocodage/reverse", "https://api-adresse.data.gouv.fr/reverse/"]) {
    try {
      const u = new URL(base); u.searchParams.set("lat", lat); u.searchParams.set("lon", lon); u.searchParams.set("limit", "1");
      if (base.includes("geopf")) u.searchParams.set("index", "address");
      const r = await fetch(u); if (!r.ok) continue;
      const f = ((await r.json()).features || [])[0]; if (f) return f.properties.label;
    } catch (e) {}
  }
  return "";
}
function ouvrirReglages(premier) {
  $("cfgIntro").textContent = (premier ? "Bienvenue ! Pour commencer, indiquez le dépôt : c'est de là que part le camion, et c'est là qu'il revient. " : "")
    + "Tapez le nom de l'entreprise ou l'adresse, puis choisissez dans la liste.";
  choix = pos(S.depot) ? { adresse: S.depot.adresse, lat: S.depot.lat, lon: S.depot.lon } : null;
  $("cfgQ").value = S.depot.adresse || ""; $("cfgGps").value = ""; suggs = []; afficherSuggs(false); statut("cfgSt", "");
  $("cfgPlusTard").textContent = premier ? "Plus tard" : "Annuler";
  $("cfg").showModal(); montrerChoix();
  if (!choix) $("cfgQ").focus();
}
$("cfgQ").oninput = (e) => {
  const q = e.target.value.trim(); clearTimeout(minuterie);
  choix = null; montrerChoix();
  if (q.length < 3) { suggs = []; afficherSuggs(false); statut("cfgSt", ""); return; }
  minuterie = setTimeout(() => suggerer(q), 300);
};
$("cfgQ").onkeydown = (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!suggs.length) return; e.preventDefault();
    actif = (actif + (e.key === "ArrowDown" ? 1 : -1) + suggs.length) % suggs.length; afficherSuggs(false);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (suggs.length) choisir(suggs[Math.max(actif, 0)]);
  }
};
$("cfgSugg").onclick = (e) => { const li = e.target.closest("li[data-i]"); if (li) choisir(suggs[+li.dataset.i]); };
$("cfgGps").oninput = async (e) => {
  const g = parseGps(e.target.value); if (!g) return;
  choix = { adresse: fmt(g), lat: g.lat, lon: g.lon }; montrerChoix();
  const l = await inverse(g.lat, g.lon); if (l && choix && choix.lat === g.lat) { choix.adresse = "Près de " + l; montrerChoix(); }
};
$("cfgIci").onclick = () => {
  if (!navigator.geolocation) { statut("cfgSt", "La position n'est pas disponible sur cet appareil.", true); return; }
  statut("cfgSt", "Recherche de votre position…");
  navigator.geolocation.getCurrentPosition(async (p) => {
    const lat = p.coords.latitude, lon = p.coords.longitude;
    choix = { adresse: fmt({ lat, lon }), lat, lon }; montrerChoix(); statut("cfgSt", "");
    const l = await inverse(lat, lon); if (l && choix && choix.lat === lat) { choix.adresse = l; $("cfgQ").value = l; montrerChoix(); }
  }, (err) => statut("cfgSt", "Position refusée ou introuvable (" + err.message + ").", true), { enableHighAccuracy: true, timeout: 15000 });
};
$("cfgOk").onclick = () => {
  if (!choix) return;
  S.depot = { adresse: choix.adresse, lat: choix.lat, lon: choix.lon, manuel: true };
  S.configure = true; S.tournee = null; save(); fillDepot(); renderRoute(); $("cfg").close();
};
$("cfgPlusTard").onclick = () => $("cfg").close();
$("depotMod").onclick = () => ouvrirReglages(false);
$("reglages").onclick = () => ouvrirReglages(false);
$("date").onchange = (e) => { S.date = e.target.value; save(); };

/* ---------------- véhicule ---------------- */
const CHAMPS_VEH = { vehHauteur: "hauteur", vehLargeur: "largeur", vehLongueur: "longueur", vehPoids: "poids", vehVolume: "volume" };
function remplirVehicule(v) {
  $("vehNom").value = v.nom || "";
  for (const [id, k] of Object.entries(CHAMPS_VEH)) $(id).value = v[k];
  $("vehServeur").value = S.serveurRoutage || "";
}
function afficherVehicule() { $("vehResume").textContent = routage.resumeVehicule(S.vehicule); }
$("vehMod").onclick = () => { remplirVehicule(S.vehicule); statut("vehSt", ""); $("veh").showModal(); };
$("vehAnnuler").onclick = () => $("veh").close();
$("vehDefaut").onclick = () => { remplirVehicule(routage.VEHICULE_DEFAUT); $("vehServeur").value = ""; };
$("vehOk").onclick = () => {
  const v = { nom: $("vehNom").value.trim() || routage.VEHICULE_DEFAUT.nom };
  for (const [id, k] of Object.entries(CHAMPS_VEH)) {
    const x = parseFloat(String($(id).value).replace(",", "."));
    if (!(x > 0)) { statut("vehSt", "Indiquez une valeur pour « " + $(id).parentElement.firstChild.textContent.trim() + " ».", true); return; }
    v[k] = x;
  }
  const serveur = $("vehServeur").value.trim();
  if (serveur && !/^https:\/\//.test(serveur)) { statut("vehSt", "L'adresse du serveur doit commencer par https://", true); return; }
  const change = JSON.stringify(v) !== JSON.stringify(S.vehicule) || serveur !== (S.serveurRoutage || "");
  S.vehicule = v; S.serveurRoutage = serveur; afficherVehicule(); $("veh").close();
  if (change) { S.tournee = null; save(); renderRoute(); if (S.points.length) calculer(); }
};

/* ---------------- fichiers ---------------- */
/* Les fichiers déposés sont gardés sur l'appareil (IndexedDB) avec leur état :
   si le téléphone se met en veille ou si le navigateur recharge la page,
   la lecture reprend là où elle s'était arrêtée. */
const BD = (() => {
  let p = null;
  const ouvrir = () => p || (p = new Promise((ok, ko) => {
    const r = indexedDB.open("tournee-pav-fichiers", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("f", { keyPath: "id" });
    r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
  }));
  const tx = async (mode, fn) => { const db = await ouvrir(); return new Promise((ok, ko) => { const t = db.transaction("f", mode); const r = fn(t.objectStore("f")); t.oncomplete = () => ok(r && r.result); t.onerror = () => ko(t.error); }); };
  return {
    mettre: (x) => tx("readwrite", (s) => s.put({ id: x.id, f: x.f, nom: x.f.name, st: x.st, res: x.res, err: x.err || null, n: x.n, rot: x.rot || 0, rotManuelle: !!x.rotManuelle, pids: x.pids || [] })).catch(() => {}),
    retirer: (id) => tx("readwrite", (s) => s.delete(id)).catch(() => {}),
    vider: () => tx("readwrite", (s) => s.clear()).catch(() => {}),
    tout: () => tx("readonly", (s) => s.getAll()).catch(() => []),
  };
})();
let ordre = 0;
function addFiles(list) {
  for (const f of list) { const x = { id: uid(), f, st: "attente", res: null, msg: "", n: ordre++ }; fichiers.push(x); BD.mettre(x); }
  renderFiles(); lireTout();
}
async function restaurerFichiers() {
  const l = (await BD.tout()) || [];
  l.sort((a, b) => a.n - b.n);
  for (const r of l) {
    const f = r.f instanceof File ? r.f : new File([r.f], r.nom || "fichier", { type: r.f?.type || "" });
    fichiers.push({ id: r.id, f, st: r.st === "lecture" ? "attente" : r.st, res: r.res, err: r.err, msg: "", n: r.n, rot: r.rot || 0, rotManuelle: !!r.rotManuelle, pids: r.pids || [] });
    ordre = Math.max(ordre, (r.n || 0) + 1);
  }
  renderFiles();
}

/* Garde l'écran allumé pendant un traitement (Screen Wake Lock), quand le navigateur le permet. */
let verrou = null, occupe = 0;
async function prendreVerrou() { try { if ("wakeLock" in navigator && !verrou && document.visibilityState === "visible") { verrou = await navigator.wakeLock.request("screen"); verrou.addEventListener("release", () => { verrou = null; }); } } catch (e) {} }
async function sansVeille(fn) {
  occupe++; prendreVerrou();
  try { return await fn(); }
  finally { if (--occupe === 0 && verrou) { verrou.release().catch(() => {}); verrou = null; } }
}
function signalerFin(txt) {
  if (document.visibilityState !== "visible") {
    document.title = "✓ " + txt;
    try { navigator.vibrate && navigator.vibrate([120, 80, 120]); } catch (e) {}
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  document.title = "Tournée PAV";
  if (occupe) prendreVerrou();
  lireTout();
});

function vignette(x) {
  if (!x.url) x.url = URL.createObjectURL(x.f);
  const t = typeDe(x.f);
  if (t === "image") return `<button class="vg" data-voir aria-label="Voir en plein écran"><img src="${x.url}" alt="" style="transform:rotate(${x.rot || 0}deg)"></button>`;
  return `<button class="vg doc" data-voir aria-label="Voir">${t === "pdf" ? "PDF" : t === "csv" ? "CSV" : "EXCEL"}</button>`;
}
function renderFiles() {
  const ul = $("files"); ul.innerHTML = "";
  for (const x of fichiers) {
    const li = document.createElement("li");
    const n = x.res ? x.res.points.length : 0;
    const cls = { attente: "p-wait", lecture: "p-run", lu: "p-ok", erreur: "p-bad" }[x.st];
    const msg = x.st === "lecture" ? x.msg || "lecture" : x.st === "attente" ? "en attente" : x.err ? "erreur" : n ? `${n} point${n > 1 ? "s" : ""}` : "aucune adresse";
    li.className = x.st === "erreur" ? "ko" : "";
    li.title = x.err || x.f.name;
    li.innerHTML = `${vignette(x)}<span class="nm"></span><span class="pill ${cls}">${esc(msg)}</span><button class="ghost" data-suppr aria-label="Retirer">×</button>`;
    li.querySelector(".nm").textContent = x.f.name;
    li.querySelector("[data-suppr]").onclick = () => { retirerPoints(x); fichiers = fichiers.filter((y) => y !== x); BD.retirer(x.id); if (x.url) URL.revokeObjectURL(x.url); renderFiles(); };
    li.querySelector("[data-voir]").onclick = () => voir(x);
    ul.appendChild(li);
  }
  $("lire").disabled = !pret || enLecture || !fichiers.some((x) => x.st === "attente" || x.st === "erreur");
  $("viderFichiers").hidden = !fichiers.length;
}
let armF = false;
$("viderFichiers").onclick = () => {
  const b = $("viderFichiers"), lib = "🗑 Retirer tous les fichiers";
  if (!armF) { armF = true; b.textContent = `Confirmer : retirer ${fichiers.length} fichier(s) et leurs points`; b.classList.add("signal"); setTimeout(() => { armF = false; b.textContent = lib; b.classList.remove("signal"); }, 4000); return; }
  armF = false; b.textContent = lib; b.classList.remove("signal");
  for (const x of fichiers) { retirerPoints(x); if (x.url) URL.revokeObjectURL(x.url); }
  fichiers = []; BD.vider(); S.tournee = null; save(); renderFiles(); renderPoints(); renderRoute(); statut("lireSt", "Fichiers retirés.");
};
function retirerPoints(x) {
  if (!x.pids || !x.pids.length) return;
  const ids = new Set(x.pids); S.points = S.points.filter((p) => !ids.has(p.id)); x.pids = []; S.tournee = null; save(); renderPoints();
}

/* Visionneuse plein écran : photo (zoom, rotation) ou pages du PDF. */
let vue = null, zoom = 1;
async function voir(x) {
  vue = x; zoom = 1;
  const t = typeDe(x.f), box = $("vueImg");
  $("vueNom").textContent = x.f.name;
  $("vuePivot").hidden = t !== "image";
  box.innerHTML = "";
  $("vueTxt").textContent = x.err ? "Erreur : " + x.err : x.res ? (x.res.texte || "(fichier tableur : pas de texte)") + `\n\n→ ${x.res.points.length} point(s) trouvé(s) (${x.res.methode}${x.res.conf ? ", confiance " + Math.round(x.res.conf) + " %" : ""})` : "Pas encore lu.";
  $("vueTexte").open = !!(x.res && !x.res.points.length) || !!x.err;
  if (t === "classeur" || t === "csv" || t === "heic") {
    box.innerHTML = `<p class="hint" style="color:#ccc">${esc(x.f.name)} : ${x.res ? x.res.points.length + " point(s) lu(s)" : "pas encore lu"}.</p>`;
  } else if (t === "image") {
    await afficherImage();
  } else {
    box.innerHTML = `<p class="hint" style="color:#ccc">Affichage du PDF…</p>`;
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.js", location.href).href;
      const doc = await pdfjsLib.getDocument({ data: await x.f.arrayBuffer(), isEvalSupported: false }).promise;
      box.innerHTML = "";
      for (let i = 1; i <= Math.min(doc.numPages, 20); i++) {
        const page = await doc.getPage(i), vp = page.getViewport({ scale: 2 });
        const cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height;
        await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
        box.appendChild(cv);
      }
      appliquerVue();
    } catch (e) { box.innerHTML = `<p class="hint" style="color:#ccc">PDF illisible : ${esc(e.message)}</p>`; }
  }
  $("vue").showModal();
}
async function afficherImage() {
  const x = vue, rot = x.rot || 0;
  const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error("image illisible")); i.src = x.url || (x.url = URL.createObjectURL(x.f)); });
  const w = img.naturalWidth, h = img.naturalHeight, debout = rot % 180 === 0;
  const cv = document.createElement("canvas"); cv.width = debout ? w : h; cv.height = debout ? h : w;
  const cx = cv.getContext("2d"); cx.translate(cv.width / 2, cv.height / 2); cx.rotate((rot * Math.PI) / 180); cx.drawImage(img, -w / 2, -h / 2);
  $("vueImg").innerHTML = ""; $("vueImg").appendChild(cv); appliquerVue();
}
function appliquerVue() {
  const box = $("vueImg");
  box.querySelectorAll("canvas").forEach((el) => { el.style.width = (100 * zoom) + "%"; });
  $("vueZoom").textContent = Math.round(zoom * 100) + " %";
}
$("vuePlus").onclick = () => { zoom = Math.min(5, zoom * 1.5); appliquerVue(); };
$("vueMoins").onclick = () => { zoom = Math.max(1, zoom / 1.5); appliquerVue(); };
$("vueFermer").onclick = () => $("vue").close();
$("vuePivot").onclick = () => {
  // Pivote d'un quart de tour et relit la photo.
  const x = vue; if (!x) return;
  x.rot = ((x.rot || 0) + 90) % 360; x.rotManuelle = true; afficherImage();
  retirerPoints(x); x.st = "attente"; x.res = null; x.err = null; BD.mettre(x); renderFiles(); lireTout();
};

const drop = $("drop");
$("choisir").onclick = () => $("fIn").click();
$("photo").onclick = () => $("pIn").click();
$("fIn").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
$("pIn").onchange = (e) => { if (e.target.files.length) $("photo").textContent = "📷 Photo suivante"; addFiles(e.target.files); e.target.value = ""; };
$("choisirPhotos").onclick = () => $("phIn").click();
$("phIn").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
["dragenter", "dragover"].forEach((v) => drop.addEventListener(v, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((v) => drop.addEventListener(v, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

/* Lecture automatique dès qu'un fichier est ajouté, un fichier à la fois.
   Reprend toute seule au retour sur l'appli si elle a été interrompue. */
let enLecture = false;
async function lireTout(avecErreurs) {
  if (enLecture || !pret) return;
  const aLire = () => fichiers.find((y) => y.st === "attente" || (avecErreurs && y.st === "erreur" && !y.tente));
  if (!aLire()) return;
  enLecture = true; let n = 0;
  await sansVeille(async () => {
    try {
      let x;
      while ((x = aLire())) {
        x.tente = true;
        const reste = fichiers.filter((y) => y.st === "attente").length;
        x.st = "lecture"; x.err = null; renderFiles(); statut("lireSt", `Lecture de ${x.f.name}… (${reste} restant${reste > 1 ? "s" : ""})`);
        BD.mettre(x);
        try {
          x.res = await lireFichier(x.f, (m) => { x.msg = m; renderFiles(); }, x.rot || 0, !!x.rotManuelle);
          if (!fichiers.includes(x)) continue; // retiré pendant la lecture
          if (x.res.rot !== undefined) x.rot = x.res.rot;
          x.st = x.res.points.length ? "lu" : "erreur";
          x.pids = [];
          for (const p of x.res.points) { p.id = uid(); x.pids.push(p.id); S.points.push(p); n++; }
        } catch (e) { x.st = "erreur"; x.err = e.message || String(e); }
        BD.mettre(x); save(); renderFiles(); renderPoints();
      }
    } finally { enLecture = false; fichiers.forEach((y) => delete y.tente); renderFiles(); }
    const lus = fichiers.filter((y) => y.st === "lu").length, err = fichiers.filter((y) => y.st === "erreur").length;
    statut("lireSt", `${lus} fichier(s) lu(s), ${n} point(s) trouvé(s).` + (err ? ` ${err} fichier(s) sans adresse ou en erreur.` : ""));
    if (n) await placer();
    signalerFin("Fiches lues");
  });
}
$("lire").onclick = () => lireTout(true);

/* ---------------- points ---------------- */
function precision(p) {
  if (p.origine === "fiche") return ["fiche", "pr-ok"];
  if (p.origine === "manuel") return ["manuel", "pr-ok"];
  if (p.origine === "introuvable") return ["introuvable", "pr-ko"];
  if (typeof p.score === "number") return [Math.round(p.score * 100) + " %", p.score >= SCORE_FIABLE ? "pr-ok" : p.score >= 0.4 ? "pr-moy" : "pr-ko"];
  return ["à placer", "pr-moy"];
}
function renderPoints() {
  const tb = $("pts"); tb.innerHTML = "";
  if (!S.points.length) { tb.innerHTML = `<tr><td colspan="9" class="hint" style="padding:14px">Aucun point. Déposez des fiches à l'étape 2 ou ajoutez un point à la main.</td></tr>`; return; }
  for (const p of S.points) {
    const tr = document.createElement("tr"); if (p.actif === false) tr.className = "off";
    const [pt, pc] = precision(p);
    tr.innerHTML = `<td><input type="checkbox" data-k="actif" ${p.actif !== false ? "checked" : ""} aria-label="Inclure"></td>
    <td><input type="text" data-k="adresse" value="${esc(p.adresse)}" style="min-width:22ch"></td>
    <td><input type="text" data-k="code_postal" value="${esc(p.code_postal)}" style="width:7ch"></td>
    <td><input type="text" data-k="commune" value="${esc(p.commune)}" style="min-width:12ch"></td>
    <td><input type="text" data-k="flux" value="${esc(p.flux)}" style="min-width:10ch"></td>
    <td><input type="text" data-k="nb_bacs" value="${esc(p.nb_bacs ?? "")}" style="width:5ch"></td>
    <td><input type="text" data-k="remarque" value="${esc(p.remarque)}" style="min-width:16ch"></td>
    <td><input type="text" data-k="gps" value="${esc(fmt(p))}" placeholder="lat, lon" style="width:19ch"><div><span class="prec ${pc}" title="${esc(p.label)}">${esc(pt)}</span></div></td>
    <td><button class="ghost" aria-label="Supprimer">×</button></td>`;
    tr.querySelectorAll("input").forEach((i) => (i.onchange = () => {
      const k = i.dataset.k;
      if (k === "actif") p.actif = i.checked;
      else if (k === "gps") { const g = parseGps(i.value); if (g) Object.assign(p, g, { origine: "manuel" }); else Object.assign(p, { lat: null, lon: null, origine: "" }); }
      else if (k === "nb_bacs") { const v = parseInt(i.value, 10); p.nb_bacs = isNaN(v) ? null : v; }
      else { p[k] = i.value; if (["adresse", "code_postal", "commune"].includes(k) && p.origine !== "manuel" && p.origine !== "fiche") Object.assign(p, { lat: null, lon: null, origine: "", score: null, label: "" }); }
      S.tournee = null; save(); renderPoints(); renderRoute();
    }));
    tr.querySelector("button").onclick = () => { S.points = S.points.filter((x) => x !== p); S.tournee = null; save(); renderPoints(); renderRoute(); };
    tb.appendChild(tr);
  }
}
$("placer").onclick = placer;
$("ajout").onclick = () => { S.points.push({ id: uid(), adresse: "", code_postal: "", commune: "", flux: "", nb_bacs: null, remarque: "", lat: null, lon: null, actif: true, origine: "", source: "manuel" }); save(); renderPoints(); };
let arm = false;
$("vider").onclick = () => {
  if (!arm) { arm = true; $("vider").textContent = "Confirmer"; setTimeout(() => { arm = false; $("vider").textContent = "Tout effacer"; }, 4000); return; }
  arm = false; $("vider").textContent = "Tout effacer"; S.points = []; S.tournee = null; fichiers = []; BD.vider(); save(); renderFiles(); renderPoints(); renderRoute();
};

/* ---------------- tournée ---------------- */
let map, layer;
function initMap() {
  map = L.map("map").setView([46.6, 2.4], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
  layer = L.layerGroup().addTo(map);
}
const icone = (txt, cls) => L.divIcon({ className: "", html: `<div class="mk ${cls || ""}">${esc(txt)}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });

async function calculer() { return sansVeille(calculerSansVeille); }
async function calculerSansVeille() {
  statut("calcSt", "Calcul…"); $("calcAlerte").textContent = "";
  try {
    if (S.points.some((p) => p.actif !== false && !pos(p) && p.origine !== "introuvable") || !pos(depotCourant())) await placer();
    const d = depotCourant();
    if (!pos(d)) throw new Error("Le dépôt n'a pas de position : vérifiez son adresse ou collez ses coordonnées GPS.");
    const m = await matriceCamion(d);
    statut("calcSt", "Recherche du meilleur ordre de passage…");
    await new Promise((r) => setTimeout(r, 20)); // laisse l'écran se mettre à jour
    const n = S.points.filter((p) => p.actif !== false && pos(p)).length;
    const generations = n > 150 ? 200 : n > 60 ? 400 : 800;
    S.tournee = JSON.parse(moteur.calculer(JSON.stringify(d), JSON.stringify(S.points), S.date || "", generations, m ? JSON.stringify(m) : ""));
    S.tournee.vehicule = routage.resumeVehicule(S.vehicule);
    statut("calcSt", S.tournee.non_places.length ? S.tournee.non_places.length + " point(s) sans position laissé(s) de côté." : "");
    save(); renderRoute();
    await tracer();
  } catch (e) { statut("calcSt", e.message || String(e), true); }
}
/** Matrice routière du camion entre le dépôt et les points actifs (null si le serveur ne répond pas). */
async function matriceCamion(d) {
  const lieux = [{ id: "depot", lat: d.lat, lon: d.lon }, ...S.points.filter((p) => p.actif !== false && pos(p)).map((p) => ({ id: p.id, lat: p.lat, lon: p.lon }))];
  if (lieux.length < 2) return null;
  const cle = routage.cleMatrice(S.serveurRoutage, S.vehicule, lieux);
  if (M.cle === cle && M.m) return M.m;
  try {
    statut("calcSt", "Distances routières du camion…");
    const m = await routage.matrice(S.serveurRoutage, S.vehicule, lieux, (k, n) => statut("calcSt", `Distances routières du camion… ${k}/${n}`));
    M = { cle, m }; garderMatrice();
    return m;
  } catch (e) {
    $("calcAlerte").textContent = `Le serveur de routage ne répond pas (${e.message}) : distances estimées à vol d'oiseau, sans tenir compte de la hauteur du camion. Réessayez avec du réseau.`;
    return null;
  }
}
/** Récupère le tracé exact sur la route, dans l'ordre de passage. */
let traceEnCours = null;
async function tracer() {
  const t = S.tournee; if (!t || !t.arrets.length) return;
  if (traceEnCours) traceEnCours.abort();
  const ctrl = (traceEnCours = new AbortController());
  const seq = [t.depot, ...t.arrets, t.depot].map((p) => ({ lat: p.lat, lon: p.lon }));
  try {
    const st = $("calcSt").textContent;
    statut("calcSt", "Tracé de l'itinéraire du camion…");
    const legs = await routage.trace(S.serveurRoutage, S.vehicule, seq, ctrl.signal);
    if (S.tournee !== t) return;
    t.trace = legs; save(); renderRoute(); statut("calcSt", st);
  } catch (e) {
    if (ctrl.signal.aborted) return;
    statut("calcSt", "Tracé sur la route indisponible (" + e.message + ") : lignes droites affichées.", true);
  } finally { if (traceEnCours === ctrl) traceEnCours = null; }
}
$("calc").onclick = calculer;
function deplacer(i, dir) {
  const t = S.tournee; const a = [...t.arrets]; const j = i + dir; if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  try {
    const m = M.m && t.distances !== "estimation" ? JSON.stringify(M.m) : "";
    S.tournee = JSON.parse(moteur.recalculer(JSON.stringify(t.depot), JSON.stringify(a), JSON.stringify(t.non_places), S.date || "", m));
    S.tournee.vehicule = t.vehicule;
    save(); renderRoute(); tracer();
  }
  catch (e) { statut("calcSt", e.message, true); }
}
function renderRoute() {
  const t = S.tournee; const ol = $("route"); layer && layer.clearLayers(); $("liens").innerHTML = ""; $("xlsx").disabled = !t;
  if (!t) { $("stats").innerHTML = ""; $("calcAlerte").textContent = ""; ol.innerHTML = `<li class="hint" style="display:block">Calculez la tournée pour obtenir l'ordre de passage.</li>`; return; }
  const bacs = t.arrets.reduce((s, p) => s + (p.nb_bacs || 0), 0);
  const route = t.distances === "route";
  const duree = t.total_min != null ? `<div class="stat"><b>${dureeTxt(t.total_min)}</b><span>de conduite</span></div>` : "";
  $("stats").innerHTML = `<div class="stat"><b>${t.arrets.length}</b><span>arrêts</span></div><div class="stat"><b>${bacs || "–"}</b><span>bacs</span></div><div class="stat"><b>${route ? "" : "≈ "}${km(t.total_km)} km</b><span>${route ? "par la route, en camion" : "distance estimée"}</span></div>${duree}`;
  const inacc = (t.inaccessibles || []).map((id) => t.arrets.find((p) => p.id === id)).filter(Boolean);
  if (inacc.length) $("calcAlerte").textContent = `Le camion (${t.vehicule || routage.resumeVehicule(S.vehicule)}) ne peut pas rejoindre ${inacc.length > 1 ? "ces arrêts" : "cet arrêt"} par la route : ${inacc.map((p) => [p.adresse, p.commune].filter(Boolean).join(", ")).join(" ; ")}. Vérifiez la position ou l'accès.`;
  else if (t.distances === "mixte") $("calcAlerte").textContent = "Certaines distances sont estimées à vol d'oiseau.";
  ol.innerHTML = "";
  const li = (k, titre, sous, cls) => {
    const e = document.createElement("li"); if (cls) e.className = cls;
    e.innerHTML = `<span class="k">${esc(k)}</span><span><b></b><small class="a"></small><small class="b"></small></span><span class="mv"></span>`;
    e.querySelector("b").textContent = titre; e.querySelector(".a").textContent = sous[0] || ""; e.querySelector(".b").textContent = sous[1] || "";
    ol.appendChild(e); return e;
  };
  li("D", t.depot.adresse || "Dépôt", ["Départ"], "depot");
  t.arrets.forEach((p, i) => {
    const e = li(i + 1, [p.adresse, p.code_postal, p.commune].filter(Boolean).join(", "), [
      [p.flux, p.nb_bacs ? p.nb_bacs + " bac(s)" : "", p.reference].filter(Boolean).join(" · "),
      [p.remarque, "+" + km(t.troncons_km[i]) + " km" + (t.troncons_min && t.troncons_min[i] != null ? " · " + dureeTxt(t.troncons_min[i]) : "")].filter(Boolean).join(" · "),
    ]);
    e.querySelector(".mv").innerHTML = `<button class="ghost" ${i === 0 ? "disabled" : ""} aria-label="Monter">▲</button><button class="ghost" ${i === t.arrets.length - 1 ? "disabled" : ""} aria-label="Descendre">▼</button>`;
    const [u, d] = e.querySelectorAll(".mv button"); u.onclick = () => deplacer(i, -1); d.onclick = () => deplacer(i, 1);
  });
  li("D", t.depot.adresse || "Dépôt", ["Retour · +" + km(t.troncons_km[t.troncons_km.length - 1]) + " km"], "depot");
  if (t.liens.length) { const h = document.createElement("p"); h.className = "hint"; h.textContent = "Attention : Google Maps calcule pour une voiture et ne connaît pas la hauteur du camion. Suivez le tracé ci-dessus près des ponts."; $("liens").appendChild(h); }
  for (const [lib, url] of t.liens) { const a = document.createElement("a"); a.className = "btn primary"; a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Google Maps : " + lib; $("liens").appendChild(a); }
  if (map) {
    const seq = [[t.depot.lat, t.depot.lon], ...t.arrets.map((p) => [p.lat, p.lon]), [t.depot.lat, t.depot.lon]];
    let cadre = seq;
    if (t.trace && t.trace.length) {
      // Tracé exact sur la route ; un trajet impossible pour le camion reste en pointillés rouges.
      for (const l of t.trace) L.polyline(l.shape, l.route ? { color: "#0f6b4f", weight: 5, opacity: 0.85 } : { color: "#b42318", weight: 3, dashArray: "6 6" }).addTo(layer);
      cadre = seq.concat(t.trace.flatMap((l) => l.shape));
    } else {
      L.polyline(seq, { color: "#0f6b4f", weight: 3, opacity: 0.6, dashArray: "6 8" }).addTo(layer);
    }
    t.arrets.forEach((p, i) => L.marker([p.lat, p.lon], { icon: icone(i + 1, p.origine === "ban" && p.score < SCORE_FIABLE ? "weak" : "") }).bindPopup(esc([p.adresse, p.commune].filter(Boolean).join(", "))).addTo(layer));
    L.marker([t.depot.lat, t.depot.lon], { icon: icone("D", "dep") }).bindPopup("Dépôt").addTo(layer);
    map.fitBounds(cadre, { padding: [24, 24] });
  }
}
$("xlsx").onclick = () => {
  try {
    const octets = moteur.excel(JSON.stringify(S.tournee));
    const b = new Blob([octets], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `tournee-pav-${S.date || "export"}.xlsx`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  } catch (e) { statut("calcSt", e.message || String(e), true); }
};
$("exemple").onclick = () => {
  const fl = [["Verre", 2], ["Emballages", 1], ["Verre", 3], ["Ordures ménagères", 2], ["Verre", 1], ["Papier", 2], ["Verre", 1], ["Emballages", 2]];
  if (S.configure && pos(S.depot)) {
    // Dépôt réglé : points d'exemple fictifs placés autour du dépôt (le dépôt n'est pas modifié).
    S.points = fl.map(([f, n], i) => {
      const ang = (i / fl.length) * 2 * Math.PI + 0.4, r = 0.03 + 0.04 * ((i * 7) % 5) / 5;
      return { id: uid(), adresse: "Point d'exemple " + (i + 1), code_postal: "", commune: "", flux: f, nb_bacs: n, remarque: "Fictif", lat: S.depot.lat + r * Math.sin(ang), lon: S.depot.lon + r * 1.5 * Math.cos(ang), actif: true, origine: "manuel", source: "exemple" };
    });
  } else {
    S.depot = { adresse: "Rue de la Donelière, 35000 Rennes", lat: null, lon: null };
    S.points = ["Place de la Mairie", "Boulevard de la Liberté", "Place Sainte-Anne", "Avenue Janvier", "Rue de Fougères", "Place de Bretagne", "Rue de Saint-Malo", "Boulevard de Vitré"]
      .map((a, i) => ({ id: uid(), adresse: a, code_postal: "35000", commune: "Rennes", flux: fl[i][0], nb_bacs: fl[i][1], remarque: "", lat: null, lon: null, actif: true, origine: "", source: "exemple" }));
  }
  S.tournee = null; save(); fillDepot(); renderPoints(); renderRoute(); calculer();
};

/* ---------------- démarrage ---------------- */
load(); fillDepot(); afficherVehicule(); renderFiles(); renderPoints();
if (!S.configure && !S.depot.adresse && !pos(S.depot)) ouvrirReglages(true);
try { initMap(); } catch (e) { $("map").textContent = "Carte indisponible"; }
renderRoute();
const restaure = restaurerFichiers();
init().then(async () => { pret = true; $("moteurSt").textContent = "Moteur prêt : la lecture et le calcul se font sur cet appareil."; await restaure; renderFiles(); lireTout(); })
  .catch((e) => { $("moteurSt").textContent = "Le moteur n'a pas pu démarrer : " + e.message; });
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
