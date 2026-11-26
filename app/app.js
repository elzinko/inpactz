// Tournée PAV : appli tout embarquée.
// Le moteur Rust (pkg/, WebAssembly) lit les fiches, calcule la tournée et produit l'Excel.
// pdf.js lit les PDF, Tesseract.js fait l'OCR des photos : tout tourne sur l'appareil.
// Seul le placement des adresses interroge la Base Adresse Nationale (service public, sans clé).

import init, * as moteur from "./pkg/tournee_wasm.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const KEY = "tournee-pav-app-v1";
const uid = () => Math.random().toString(36).slice(2, 9);
const SCORE_FIABLE = 0.6;
const GEOCODEURS = ["https://data.geopf.fr/geocodage/search", "https://api-adresse.data.gouv.fr/search/"];

let S = { depot: { adresse: "", lat: null, lon: null }, date: "", points: [], tournee: null };
let fichiers = [];
let pret = false;

/* ---------------- état ---------------- */
function load() { try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s) S = Object.assign(S, s); } catch (e) {} }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
function parseGps(s) { const m = String(s || "").match(/(-?\d{1,2}[.,]\d+)\s*[,; ]\s*(-?\d{1,3}[.,]\d+)/); return m ? { lat: +m[1].replace(",", "."), lon: +m[2].replace(",", ".") } : null; }
const pos = (p) => p && typeof p.lat === "number" && typeof p.lon === "number";
const fmt = (p) => (pos(p) ? p.lat.toFixed(5) + ", " + p.lon.toFixed(5) : "");
const km = (x) => x.toFixed(1).replace(".", ",");
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
async function ocr(image, progression) {
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
  return r.data.text;
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

async function imagePourOcr(f) {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("image illisible")); i.src = url; });
    const max = 2600, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement("canvas"); cv.width = Math.round(img.naturalWidth * sc); cv.height = Math.round(img.naturalHeight * sc);
    const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0, cv.width, cv.height);
    return cv;
  } finally { URL.revokeObjectURL(url); }
}

async function lireFichier(f, progression) {
  const t = typeDe(f);
  if (t === "heic") throw new Error("Format HEIC : réglez l'appareil photo en « Le plus compatible » (JPEG).");
  if (t === "classeur") return { points: JSON.parse(moteur.lire_classeur(new Uint8Array(await f.arrayBuffer()), f.name)), texte: "", methode: "Excel" };
  if (t === "csv") return { points: JSON.parse(moteur.lire_csv(await f.text(), f.name)), texte: "", methode: "CSV" };
  let texte, methode;
  if (t === "pdf") ({ texte } = await textePdf(await f.arrayBuffer(), progression), methode = "PDF");
  else { progression("OCR"); texte = await ocr(await imagePourOcr(f), progression); methode = "OCR"; }
  return { points: JSON.parse(moteur.analyser_texte(texte, f.name)), texte, methode };
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

/* ---------------- fichiers ---------------- */
function addFiles(list) { for (const f of list) fichiers.push({ f, st: "attente", res: null, msg: "" }); renderFiles(); }
function renderFiles() {
  const ul = $("files"); ul.innerHTML = "";
  for (const x of fichiers) {
    const li = document.createElement("li");
    const cls = { attente: "p-wait", lecture: "p-run", lu: "p-ok", erreur: "p-bad" }[x.st];
    const msg = x.st === "lecture" ? x.msg || "lecture" : x.res ? `${x.res.points.length} point(s) · ${x.res.methode}` : x.st === "erreur" ? "erreur" : "en attente";
    li.innerHTML = `<span class="nm"></span><span class="pill ${cls}">${esc(msg)}</span><button class="ghost" aria-label="Retirer">×</button>`;
    li.querySelector(".nm").textContent = x.f.name;
    li.querySelector("button").onclick = () => { fichiers = fichiers.filter((y) => y !== x); renderFiles(); };
    if (x.res || x.err) {
      const d = document.createElement("details"); d.className = "txt";
      d.innerHTML = `<summary class="hint"></summary><pre></pre>`;
      d.querySelector("summary").textContent = x.err || (x.res.points.length ? "Voir le texte lu" : "Aucune adresse reconnue : voir le texte lu");
      d.querySelector("pre").textContent = x.res?.texte || "(pas de texte)";
      li.appendChild(d);
    }
    ul.appendChild(li);
  }
  $("lire").disabled = !pret || !fichiers.some((x) => x.st === "attente" || x.st === "erreur");
}
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

$("lire").onclick = async () => {
  $("lire").disabled = true; let n = 0;
  for (const x of fichiers.filter((y) => y.st === "attente" || y.st === "erreur")) {
    x.st = "lecture"; x.err = null; renderFiles(); statut("lireSt", "Lecture de " + x.f.name + "…");
    try {
      x.res = await lireFichier(x.f, (m) => { x.msg = m; renderFiles(); });
      x.st = x.res.points.length ? "lu" : "erreur";
      for (const p of x.res.points) { p.id = uid(); S.points.push(p); n++; }
    } catch (e) { x.st = "erreur"; x.err = e.message || String(e); }
    renderFiles(); save(); renderPoints();
  }
  statut("lireSt", n + " point(s) trouvé(s).");
  if (n) await placer();
};

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
  arm = false; $("vider").textContent = "Tout effacer"; S.points = []; S.tournee = null; fichiers = []; save(); renderFiles(); renderPoints(); renderRoute();
};

/* ---------------- tournée ---------------- */
let map, layer;
function initMap() {
  map = L.map("map").setView([46.6, 2.4], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
  layer = L.layerGroup().addTo(map);
}
const icone = (txt, cls) => L.divIcon({ className: "", html: `<div class="mk ${cls || ""}">${esc(txt)}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });

async function calculer() {
  statut("calcSt", "Calcul…");
  try {
    if (S.points.some((p) => p.actif !== false && !pos(p) && p.origine !== "introuvable") || !pos(depotCourant())) await placer();
    const d = depotCourant();
    if (!pos(d)) throw new Error("Le dépôt n'a pas de position : vérifiez son adresse ou collez ses coordonnées GPS.");
    await new Promise((r) => setTimeout(r, 20)); // laisse l'écran se mettre à jour
    const n = S.points.filter((p) => p.actif !== false && pos(p)).length;
    const generations = n > 150 ? 200 : n > 60 ? 400 : 800;
    S.tournee = JSON.parse(moteur.calculer(JSON.stringify(d), JSON.stringify(S.points), S.date || "", generations));
    statut("calcSt", S.tournee.non_places.length ? S.tournee.non_places.length + " point(s) sans position laissé(s) de côté." : "");
    save(); renderRoute();
  } catch (e) { statut("calcSt", e.message || String(e), true); }
}
$("calc").onclick = calculer;
function deplacer(i, dir) {
  const t = S.tournee; const a = [...t.arrets]; const j = i + dir; if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  try { S.tournee = JSON.parse(moteur.recalculer(JSON.stringify(t.depot), JSON.stringify(a), JSON.stringify(t.non_places), S.date || "")); save(); renderRoute(); }
  catch (e) { statut("calcSt", e.message, true); }
}
function renderRoute() {
  const t = S.tournee; const ol = $("route"); layer && layer.clearLayers(); $("liens").innerHTML = ""; $("xlsx").disabled = !t;
  if (!t) { $("stats").innerHTML = ""; ol.innerHTML = `<li class="hint" style="display:block">Calculez la tournée pour obtenir l'ordre de passage.</li>`; return; }
  const bacs = t.arrets.reduce((s, p) => s + (p.nb_bacs || 0), 0);
  $("stats").innerHTML = `<div class="stat"><b>${t.arrets.length}</b><span>arrêts</span></div><div class="stat"><b>${bacs || "–"}</b><span>bacs</span></div><div class="stat"><b>≈ ${km(t.total_km)} km</b><span>distance estimée</span></div>`;
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
      [p.remarque, "+" + km(t.troncons_km[i]) + " km"].filter(Boolean).join(" · "),
    ]);
    e.querySelector(".mv").innerHTML = `<button class="ghost" ${i === 0 ? "disabled" : ""} aria-label="Monter">▲</button><button class="ghost" ${i === t.arrets.length - 1 ? "disabled" : ""} aria-label="Descendre">▼</button>`;
    const [u, d] = e.querySelectorAll(".mv button"); u.onclick = () => deplacer(i, -1); d.onclick = () => deplacer(i, 1);
  });
  li("D", t.depot.adresse || "Dépôt", ["Retour · +" + km(t.troncons_km[t.troncons_km.length - 1]) + " km"], "depot");
  for (const [lib, url] of t.liens) { const a = document.createElement("a"); a.className = "btn primary"; a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Google Maps : " + lib; $("liens").appendChild(a); }
  if (map) {
    const seq = [[t.depot.lat, t.depot.lon], ...t.arrets.map((p) => [p.lat, p.lon]), [t.depot.lat, t.depot.lon]];
    L.polyline(seq, { color: "#0f6b4f", weight: 4, opacity: 0.85 }).addTo(layer);
    t.arrets.forEach((p, i) => L.marker([p.lat, p.lon], { icon: icone(i + 1, p.origine === "ban" && p.score < SCORE_FIABLE ? "weak" : "") }).bindPopup(esc([p.adresse, p.commune].filter(Boolean).join(", "))).addTo(layer));
    L.marker([t.depot.lat, t.depot.lon], { icon: icone("D", "dep") }).bindPopup("Dépôt").addTo(layer);
    map.fitBounds(seq, { padding: [24, 24] });
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
load(); fillDepot(); renderFiles(); renderPoints();
if (!S.configure && !S.depot.adresse && !pos(S.depot)) ouvrirReglages(true);
try { initMap(); } catch (e) { $("map").textContent = "Carte indisponible"; }
renderRoute();
init().then(() => { pret = true; $("moteurSt").textContent = "Moteur prêt : la lecture et le calcul se font sur cet appareil."; renderFiles(); })
  .catch((e) => { $("moteurSt").textContent = "Le moteur n'a pas pu démarrer : " + e.message; });
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
