#!/usr/bin/env python3
"""Tournée PAV : géocode des points de collecte (BAN, sans clé), calcule l'ordre de
passage (OR-Tools, problème du voyageur de commerce, sans LLM) et écrit un Excel.

Entrée : un CSV (séparateur ; ou ,) avec au moins la colonne "adresse".
Colonnes reconnues : adresse, code_postal, commune, flux, nb_bacs, volume,
reference, remarque, lat, lon, source.

Usage :
  python3 tournee.py points.csv --depot "12 rue X, 35000 Rennes" -o tournee.xlsx
  python3 tournee.py points.csv --depot-gps "48.11,-1.68" -o tournee.xlsx
"""
import argparse, csv, json, math, os, sys, time, urllib.parse, urllib.request

GEOCODERS = [
    os.environ.get("TOURNEE_GEOCODER_URL") or "https://data.geopf.fr/geocodage/search",
    "https://api-adresse.data.gouv.fr/search/",
]
ROAD_FACTOR = 1.3      # vol d'oiseau -> route, estimation
SCORE_OK = 0.6         # en dessous, le point part dans l'onglet "À vérifier"
UA = "tournee-pav/1.0"


# ---------------------------------------------------------------- lecture CSV
def read_points(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        sample = f.read(4096); f.seek(0)
        delim = ";" if sample.count(";") >= sample.count(",") else ","
        rows = list(csv.DictReader(f, delimiter=delim))
    pts = []
    for r in rows:
        r = {(k or "").strip().lower(): (v or "").strip() for k, v in r.items()}
        if not (r.get("adresse") or r.get("commune") or (r.get("lat") and r.get("lon"))):
            continue
        p = {k: r.get(k, "") for k in ("adresse", "code_postal", "commune", "flux", "nb_bacs",
                                         "volume", "reference", "remarque", "source")}
        p["lat"], p["lon"] = to_float(r.get("lat")), to_float(r.get("lon"))
        p["geo_label"], p["geo_score"], p["geo_type"] = "", None, ""
        p["geo_src"] = "fiche" if p["lat"] is not None else ""
        pts.append(p)
    return pts


def to_float(v):
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None


def parse_gps(s):
    parts = [x for x in s.replace(";", ",").replace(" ", ",").split(",") if x]
    if len(parts) == 4:  # "48,11 ; -1,68" écrit à la française
        parts = [parts[0] + "." + parts[1], parts[2] + "." + parts[3]]
    lat, lon = to_float(parts[0]), to_float(parts[1])
    if lat is None or lon is None:
        sys.exit(f"Coordonnées du dépôt illisibles : {s}")
    return lat, lon


# ---------------------------------------------------------------- géocodage BAN
def geocode(query, near=None):
    last_err = None
    for base in GEOCODERS:
        params = {"q": query[:200], "limit": 1, "index": "address"}
        if near:
            params["lat"], params["lon"] = f"{near[0]:.5f}", f"{near[1]:.5f}"
        url = base + ("&" if "?" in base else "?") + urllib.parse.urlencode(params)
        if "api-adresse" in base:
            url = url.replace("&index=address", "")
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=15) as r:
                    data = json.load(r)
                feats = data.get("features") or []
                if not feats:
                    return None
                f = feats[0]
                lon, lat = f["geometry"]["coordinates"][:2]
                pr = f.get("properties", {})
                return {"lat": lat, "lon": lon, "label": pr.get("label", ""),
                        "score": pr.get("score"), "type": pr.get("type", "")}
            except urllib.error.HTTPError as e:
                last_err = e
                if e.code == 429:
                    time.sleep(1.5 * (attempt + 1)); continue
                break
            except Exception as e:  # réseau coupé, DNS, timeout
                last_err = e
                break
    raise ConnectionError(f"Service d'adresses injoignable ({last_err})")


def query_of(p):
    return ", ".join(x for x in (p["adresse"], " ".join(x for x in (p["code_postal"], p["commune"]) if x)) if x)


# ---------------------------------------------------------------- distances
def hav(a, b):
    R, r = 6371.0, math.pi / 180
    dlat, dlon = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def matrix(coords):
    return [[hav(a, b) * ROAD_FACTOR for b in coords] for a in coords]


# ---------------------------------------------------------------- voyageur de commerce
def solve_ortools(D, seconds):
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2
    n = len(D)
    M = [[int(round(d * 1000)) for d in row] for row in D]  # mètres entiers
    mgr = pywrapcp.RoutingIndexManager(n, 1, 0)
    routing = pywrapcp.RoutingModel(mgr)
    cb = routing.RegisterTransitCallback(lambda i, j: M[mgr.IndexToNode(i)][mgr.IndexToNode(j)])
    routing.SetArcCostEvaluatorOfAllVehicles(cb)
    prm = pywrapcp.DefaultRoutingSearchParameters()
    prm.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    prm.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    prm.time_limit.seconds = seconds
    sol = routing.SolveWithParameters(prm)
    if not sol:
        raise RuntimeError("OR-Tools n'a pas trouvé de solution")
    idx, order = routing.Start(0), []
    while not routing.IsEnd(idx):
        order.append(mgr.IndexToNode(idx)); idx = sol.Value(routing.NextVar(idx))
    return order  # commence par 0 (dépôt)


def solve_fallback(D):
    """Plus proche voisin + 2-opt, si OR-Tools n'est pas installable."""
    n = len(D); seen = {0}; t = [0]
    while len(t) < n:
        last = t[-1]
        nxt = min((j for j in range(n) if j not in seen), key=lambda j: D[last][j])
        seen.add(nxt); t.append(nxt)
    t.append(0)
    improved = True
    while improved:
        improved = False
        for i in range(1, len(t) - 2):
            for j in range(i + 1, len(t) - 1):
                a, b, c, d = t[i - 1], t[i], t[j], t[j + 1]
                if D[a][c] + D[b][d] < D[a][b] + D[c][d] - 1e-9:
                    t[i:j + 1] = reversed(t[i:j + 1]); improved = True
    return t[:-1]


def solve(D, seconds):
    if len(D) <= 2:
        return list(range(len(D))), "trivial"
    try:
        return solve_ortools(D, seconds), "OR-Tools"
    except ImportError:
        return solve_fallback(D), "2-opt (OR-Tools absent)"


# ---------------------------------------------------------------- Excel
def gmaps_dir(seq):
    q = lambda c: f"{c[0]:.6f},{c[1]:.6f}"
    url = ("https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=" + q(seq[0]) +
           "&destination=" + q(seq[-1]))
    if len(seq) > 2:
        url += "&waypoints=" + urllib.parse.quote("|".join(q(c) for c in seq[1:-1]))
    return url


def write_xlsx(path, depot, stops, unplaced, legs, total_km, method, date):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter

    wb = Workbook(); ws = wb.active; ws.title = "Tournée"
    head = Font(bold=True, color="FFFFFF"); fill = PatternFill("solid", fgColor="17251F")
    dep_fill = PatternFill("solid", fgColor="F2A900"); warn = PatternFill("solid", fgColor="FFF4E0")
    thin = Border(bottom=Side(style="thin", color="D5DDD8"))
    ws["A1"] = "Tournée PAV" + (f" du {date}" if date else ""); ws["A1"].font = Font(bold=True, size=14)
    nb_bacs = sum(int(to_float(p["nb_bacs"]) or 0) for p in stops)
    ws["A2"] = f"{len(stops)} arrêts · {nb_bacs} bacs · environ {total_km:.1f} km · ordre calculé par {method}"
    ws["A3"] = f"Départ et retour : {depot['label']}"
    cols = ["Fait", "Ordre", "Adresse", "Code postal", "Commune", "Flux", "Bacs", "Volume", "Référence",
            "Remarque", "Adresse trouvée", "Fiabilité", "Latitude", "Longitude", "Km depuis l'arrêt précédent",
            "Google Maps", "Fiche source"]
    widths = [6, 7, 34, 11, 18, 16, 6, 9, 12, 30, 40, 10, 11, 11, 12, 14, 22]
    R = 5
    for c, (h, w) in enumerate(zip(cols, widths), 1):
        cell = ws.cell(R, c, h); cell.font = head; cell.fill = fill
        cell.alignment = Alignment(wrap_text=True, vertical="center")
        ws.column_dimensions[get_column_letter(c)].width = w

    def row(values, fill_=None, link=None):
        nonlocal R
        R += 1
        for c, v in enumerate(values, 1):
            cell = ws.cell(R, c, v); cell.border = thin
            cell.alignment = Alignment(wrap_text=c in (3, 10, 11), vertical="top")
            if fill_: cell.fill = fill_
        if link:
            cell = ws.cell(R, 16, "Ouvrir"); cell.hyperlink = link; cell.font = Font(color="0F6B4F", underline="single")

    def maps(lat, lon):
        return f"https://www.google.com/maps/search/?api=1&query={lat:.6f},{lon:.6f}"

    row(["", "D", depot["label"], "", "", "Départ", "", "", "", "", depot["label"], "", depot["lat"], depot["lon"], "", ""],
        dep_fill, maps(depot["lat"], depot["lon"]))
    for i, p in enumerate(stops):
        sc = p["geo_score"]
        fiab = "fiche" if p["geo_src"] == "fiche" else (f"{sc:.0%}" if sc is not None else "")
        low = p["geo_src"] != "fiche" and (sc is None or sc < SCORE_OK)
        nb = to_float(p["nb_bacs"])
        row(["☐", i + 1, p["adresse"], p["code_postal"], p["commune"], p["flux"],
             int(nb) if nb is not None else p["nb_bacs"], p["volume"], p["reference"], p["remarque"],
             p["geo_label"], fiab, round(p["lat"], 6), round(p["lon"], 6), round(legs[i], 1), "", p["source"]],
            warn if low else None, maps(p["lat"], p["lon"]))
    row(["", "D", depot["label"], "", "", "Retour", "", "", "", "", depot["label"], "", depot["lat"], depot["lon"],
         round(legs[len(stops)], 1), ""], dep_fill, maps(depot["lat"], depot["lon"]))
    ws.freeze_panes = "D6"
    ws.auto_filter.ref = f"A5:{get_column_letter(len(cols))}{R}"
    ws.page_setup.orientation = "landscape"; ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_title_rows = "5:5"

    # Itinéraire Google Maps, 8 arrêts par lien (limite des liens Google Maps)
    it = wb.create_sheet("Itinéraire")
    it["A1"] = "Itinéraire à ouvrir dans Google Maps (par tronçons de 8 arrêts)"; it["A1"].font = Font(bold=True)
    seq = [(depot["lat"], depot["lon"])] + [(p["lat"], p["lon"]) for p in stops] + [(depot["lat"], depot["lon"])]
    r, s = 3, 0
    while s < len(seq) - 1:
        chunk = seq[s:s + 10]
        a = "Départ" if s == 0 else f"Arrêt {s}"
        e = s + len(chunk) - 1
        b = "Retour dépôt" if e > len(stops) else f"Arrêt {e}"
        it.cell(r, 1, f"{a} → {b}")
        c = it.cell(r, 2, "Ouvrir l'itinéraire"); c.hyperlink = gmaps_dir(chunk)
        c.font = Font(color="0F6B4F", underline="single")
        r += 1; s += 9
    it.column_dimensions["A"].width = 28; it.column_dimensions["B"].width = 24

    if unplaced:
        ko = wb.create_sheet("À vérifier")
        ko.append(["Adresse", "Code postal", "Commune", "Flux", "Bacs", "Remarque", "Problème", "Fiche source"])
        for c in ko[1]: c.font = head; c.fill = fill
        for p, why in unplaced:
            ko.append([p["adresse"], p["code_postal"], p["commune"], p["flux"], p["nb_bacs"], p["remarque"], why, p["source"]])
        for col, w in zip("ABCDEFGH", [34, 11, 18, 16, 6, 30, 40, 22]):
            ko.column_dimensions[col].width = w
    wb.save(path)


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("points_csv")
    ap.add_argument("--depot", help="adresse du dépôt (départ et retour)")
    ap.add_argument("--depot-gps", help='coordonnées du dépôt "lat,lon" (prioritaire sur --depot)')
    ap.add_argument("-o", "--output", default="tournee.xlsx")
    ap.add_argument("--date", default="")
    ap.add_argument("--seconds", type=int, default=10, help="temps de recherche OR-Tools")
    a = ap.parse_args()
    if not (a.depot or a.depot_gps):
        sys.exit("Indique le dépôt avec --depot \"adresse\" ou --depot-gps \"lat,lon\".")

    pts = read_points(a.points_csv)
    if not pts:
        sys.exit("Aucun point dans le CSV.")

    # dépôt
    if a.depot_gps:
        lat, lon = parse_gps(a.depot_gps)
        depot = {"lat": lat, "lon": lon, "label": a.depot or f"{lat:.5f}, {lon:.5f}"}
    else:
        g = geocode(a.depot)
        if not g:
            sys.exit(f"Dépôt introuvable : {a.depot}")
        depot = {"lat": g["lat"], "lon": g["lon"], "label": g["label"] or a.depot}
        if (g["score"] or 0) < SCORE_OK:
            print(f"ATTENTION dépôt peu fiable ({g['score']:.0%}) : {g['label']}")
    near = (depot["lat"], depot["lon"])

    # géocodage des points
    unplaced = []
    for p in pts:
        if p["lat"] is not None and p["lon"] is not None:
            continue
        q = query_of(p)
        g = geocode(q, near) if q else None
        time.sleep(0.05)  # reste sous la limite de 50 requêtes/s
        if not g:
            unplaced.append((p, "adresse introuvable")); continue
        p.update(lat=g["lat"], lon=g["lon"], geo_label=g["label"], geo_score=g["score"], geo_type=g["type"], geo_src="BAN")
        if hav(near, (p["lat"], p["lon"])) > 80:
            unplaced.append((p, f"trouvée à plus de 80 km du dépôt : {g['label']}"))
            p["lat"] = p["lon"] = None
    stops_in = [p for p in pts if p["lat"] is not None]

    # dédoublonnage (même position et même flux)
    seen, uniq = {}, []
    for p in stops_in:
        k = (round(p["lat"], 5), round(p["lon"], 5), p["flux"].lower())
        if k in seen:
            q = seen[k]
            a1, a2 = to_float(q["nb_bacs"]), to_float(p["nb_bacs"])
            if a1 is not None or a2 is not None:
                q["nb_bacs"] = str(int((a1 or 0) + (a2 or 0)))
            if p["remarque"] and p["remarque"] not in q["remarque"]:
                q["remarque"] = "; ".join(x for x in (q["remarque"], p["remarque"]) if x)
            continue
        seen[k] = p; uniq.append(p)

    coords = [near] + [(p["lat"], p["lon"]) for p in uniq]
    D = matrix(coords)
    order, method = solve(D, a.seconds)
    stops = [uniq[i - 1] for i in order[1:]]
    nodes = [0] + order[1:] + [0]
    legs = [D[nodes[i]][nodes[i + 1]] for i in range(len(nodes) - 1)]
    total = sum(legs)

    write_xlsx(a.output, depot, stops, unplaced, legs, total, method, a.date)
    low = sum(1 for p in stops if p["geo_src"] == "BAN" and (p["geo_score"] or 0) < SCORE_OK)
    print(json.dumps({"fichier": a.output, "arrets": len(stops), "km_estimes": round(total, 1),
                      "methode": method, "a_verifier": len(unplaced), "peu_fiables": low,
                      "ordre": [query_of(p) for p in stops]}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
