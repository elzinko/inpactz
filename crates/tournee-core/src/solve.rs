//! Ordre de passage : problème du voyageur de commerce résolu par `vrp-pragmatic`
//! (solveur open source de tournées, licence Apache 2.0). Aucun LLM.

use crate::model::{km_route, Depot, Matrice, Point, Tournee};
use std::collections::HashMap;
use std::io::BufWriter;
use std::sync::Arc;
use vrp_core::solver::{Solver, VrpConfigBuilder};
use vrp_core::utils::Environment;
use vrp_pragmatic::format::problem::PragmaticProblem;
use vrp_pragmatic::format::solution::{write_pragmatic, PragmaticOutputType};

/// Identifiant du dépôt dans la matrice.
pub const ID_DEPOT: &str = "depot";
/// Pénalité (mètres) d'un trajet impossible pour le camion : le solveur l'évite à tout prix.
const PENALITE_M: f64 = 10_000_000.0;

/// Un lieu de la tournée : identifiant (pour la matrice) et position.
#[derive(Clone)]
struct Lieu {
    id: String,
    pos: (f64, f64),
}

/// Coût d'un trajet : mètres, secondes, et sa provenance.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Trajet {
    /// Distance routière du camion.
    Route(f64, f64),
    /// Le moteur de routage n'a trouvé aucun chemin pour ce véhicule.
    Impossible,
    /// Pas de matrice : estimation à vol d'oiseau × 1,3.
    Estime(f64),
}

fn trajet(m: Option<&Matrice>, a: &Lieu, b: &Lieu) -> Trajet {
    match m.and_then(|m| m.trajet(&a.id, &b.id)) {
        Some(Some((d, t))) => Trajet::Route(d, t),
        Some(None) if a.id != b.id => Trajet::Impossible,
        _ => Trajet::Estime(km_route(a.pos, b.pos) * 1000.0),
    }
}

/// Mètres utilisés par le solveur.
fn cout_m(t: Trajet, a: &Lieu, b: &Lieu) -> f64 {
    match t {
        Trajet::Route(d, _) => d,
        Trajet::Estime(d) => d,
        Trajet::Impossible => PENALITE_M + km_route(a.pos, b.pos) * 1000.0,
    }
}

/// Calcule la tournée à vol d'oiseau (sans moteur de routage).
pub fn calculer(depot: &Depot, points: &[Point], generations: usize) -> Result<Tournee, String> {
    calculer_avec(depot, points, generations, None)
}

/// Calcule la tournée : départ du dépôt, tous les points actifs placés, retour au dépôt.
/// Avec une matrice routière (profil camion), l'ordre minimise les vrais kilomètres
/// et évite les passages interdits au véhicule (ponts bas, tonnage…).
pub fn calculer_avec(depot: &Depot, points: &[Point], generations: usize, matrice: Option<&Matrice>) -> Result<Tournee, String> {
    let d = depot.position().ok_or("Le dépôt n'a pas de position.")?;
    let actifs: Vec<&Point> = points.iter().filter(|p| p.actif).collect();
    let (places, non_places): (Vec<&Point>, Vec<&Point>) = actifs.into_iter().partition(|p| p.position().is_some());

    let mut lieux = vec![Lieu { id: ID_DEPOT.into(), pos: d }];
    lieux.extend(places.iter().map(|p| Lieu { id: p.id.clone(), pos: p.position().unwrap() }));

    let (ordre, methode) = match places.len() {
        0 => (vec![], "aucun point".to_string()),
        1 => (vec![0], "un seul point".to_string()),
        _ => (resoudre(&lieux, matrice, generations)?, "vrp-pragmatic".to_string()),
    };

    let arrets: Vec<Point> = ordre.iter().map(|&i| places[i].clone()).collect();
    let mut t = assembler(depot, arrets, matrice);
    t.methode = methode;
    t.non_places = non_places.into_iter().cloned().collect();
    Ok(t)
}

/// Distances et durées de chaque tronçon d'un ordre donné.
fn assembler(depot: &Depot, arrets: Vec<Point>, matrice: Option<&Matrice>) -> Tournee {
    let d = depot.position().unwrap_or((0.0, 0.0));
    let depot_l = Lieu { id: ID_DEPOT.into(), pos: d };
    let mut seq = vec![depot_l.clone()];
    seq.extend(arrets.iter().filter_map(|p| p.position().map(|pos| Lieu { id: p.id.clone(), pos })));
    seq.push(depot_l);

    let mut troncons_km = vec![];
    let mut troncons_min = vec![];
    let (mut routes, mut estimes) = (0, 0);
    let mut inaccessibles: Vec<String> = vec![];
    for w in seq.windows(2) {
        match trajet(matrice, &w[0], &w[1]) {
            Trajet::Route(m, s) => {
                routes += 1;
                troncons_km.push(m / 1000.0);
                troncons_min.push(s / 60.0);
            }
            t => {
                estimes += 1;
                if t == Trajet::Impossible {
                    // L'arrêt « hors d'atteinte » est celui qui n'est pas le dépôt.
                    let id = if w[1].id == ID_DEPOT { &w[0].id } else { &w[1].id };
                    if !inaccessibles.contains(id) {
                        inaccessibles.push(id.clone());
                    }
                }
                let km = km_route(w[0].pos, w[1].pos);
                troncons_km.push(km);
                troncons_min.push(km * 2.0); // 30 km/h
            }
        }
    }
    let distances = match (routes, estimes) {
        (_, 0) if routes > 0 => "route",
        (0, _) => "estimation",
        _ => "mixte",
    };
    Tournee {
        depot: depot.clone(),
        total_km: troncons_km.iter().sum(),
        total_min: (distances == "route").then(|| troncons_min.iter().sum()),
        troncons_km,
        troncons_min: if distances == "route" { troncons_min } else { vec![] },
        arrets,
        non_places: vec![],
        methode: String::new(),
        date: String::new(),
        distances: distances.into(),
        inaccessibles,
        vehicule: String::new(),
    }
}

/// Renvoie l'ordre de visite (indices dans `places`).
/// `lieux[0]` est le dépôt.
fn resoudre(lieux: &[Lieu], matrice: Option<&Matrice>, generations: usize) -> Result<Vec<usize>, String> {
    // Matrice des distances (mètres) et durées (secondes) : routières si connues,
    // sinon estimées (vol d'oiseau × 1,3, 30 km/h).
    let n = lieux.len();
    let mut distances = Vec::with_capacity(n * n);
    let mut durees = Vec::with_capacity(n * n);
    for a in lieux {
        for b in lieux {
            let t = trajet(matrice, a, b);
            let m = cout_m(t, a, b).round() as i64;
            distances.push(m);
            durees.push(match t {
                Trajet::Route(_, s) => s.round() as i64,
                _ => m * 120 / 1000,
            });
        }
    }
    let places = &lieux[1..];
    let jobs: Vec<_> = places
        .iter()
        .enumerate()
        .map(|(i, _)| {
            serde_json::json!({"id": format!("j{i}"),
                "services": [{"places": [{"location": {"index": i + 1}, "duration": 0}]}]})
        })
        .collect();
    let probleme = serde_json::json!({
        "plan": {"jobs": jobs},
        "fleet": {
            "vehicles": [{
                "typeId": "camion", "vehicleIds": ["camion_1"],
                "profile": {"matrix": "route"},
                "costs": {"fixed": 0, "distance": 1, "time": 0},
                "shifts": [{
                    "start": {"earliest": "2026-01-01T05:00:00Z", "location": {"index": 0}},
                    "end": {"latest": "2026-01-03T05:00:00Z", "location": {"index": 0}}
                }],
                "capacity": [1_000_000]
            }],
            "profiles": [{"name": "route"}]
        }
    });
    let matrice = serde_json::json!({"profile": "route", "travelTimes": durees, "distances": distances});

    let core = (probleme.to_string(), vec![matrice.to_string()])
        .read_pragmatic()
        .map_err(|e| format!("problème invalide : {e:?}"))?;
    let core = Arc::new(core);
    let env = Arc::new(Environment { logger: Arc::new(|_: &str| {}), ..Environment::default() });
    let config = VrpConfigBuilder::new(core.clone())
        .set_environment(env)
        .prebuild()
        .map_err(|e| e.to_string())?
        .with_max_generations(Some(generations))
        .build()
        .map_err(|e| e.to_string())?;
    let solution = Solver::new(core.clone(), config).solve().map_err(|e| e.to_string())?;

    let mut buf = BufWriter::new(Vec::new());
    write_pragmatic(&core, &solution, PragmaticOutputType::OnlyPragmatic, &mut buf).map_err(|e| e.to_string())?;
    let v: serde_json::Value =
        serde_json::from_slice(&buf.into_inner().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;

    let index: HashMap<String, usize> = (0..places.len()).map(|i| (format!("j{i}"), i)).collect();
    let mut ordre = vec![];
    if let Some(stops) = v["tours"][0]["stops"].as_array() {
        for s in stops {
            for a in s["activities"].as_array().into_iter().flatten() {
                if let Some(i) = a["jobId"].as_str().and_then(|j| index.get(j)) {
                    if !ordre.contains(i) {
                        ordre.push(*i);
                    }
                }
            }
        }
    }
    // Sécurité : tout point oublié par le solveur est ajouté à la fin.
    for i in 0..places.len() {
        if !ordre.contains(&i) {
            ordre.push(i);
        }
    }
    Ok(ordre)
}

/// Recalcule les distances quand l'utilisateur change l'ordre à la main.
pub fn recalculer(depot: &Depot, arrets: Vec<Point>) -> Result<Tournee, String> {
    recalculer_avec(depot, arrets, None)
}

/// Comme [`recalculer`], avec la matrice routière si elle est connue.
pub fn recalculer_avec(depot: &Depot, arrets: Vec<Point>, matrice: Option<&Matrice>) -> Result<Tournee, String> {
    depot.position().ok_or("Le dépôt n'a pas de position.")?;
    let mut t = assembler(depot, arrets, matrice);
    t.methode = "ordre modifié à la main".into();
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(i: usize, lat: f64, lon: f64) -> Point {
        Point { id: format!("p{i}"), adresse: format!("Point {i}"), lat: Some(lat), lon: Some(lon), actif: true, ..Default::default() }
    }

    #[test]
    fn tournee_sans_croisement() {
        // Points sur un cercle autour du dépôt mélangés : l'optimum suit le cercle.
        let depot = Depot { adresse: "Dépôt".into(), lat: Some(48.0), lon: Some(-1.6) };
        let mut pts = vec![];
        for k in [3, 7, 1, 5, 0, 6, 2, 4] {
            let a = k as f64 * std::f64::consts::PI / 4.0;
            pts.push(pt(k, 48.05 + 0.02 * a.sin(), -1.6 + 0.03 * a.cos()));
        }
        let t = calculer(&depot, &pts, 300).unwrap();
        assert_eq!(t.arrets.len(), 8);
        assert_eq!(t.troncons_km.len(), 9);
        // L'ordre doit faire le tour : voisins consécutifs sur le cercle.
        let ids: Vec<usize> = t.arrets.iter().map(|p| p.id[1..].parse().unwrap()).collect();
        for w in ids.windows(2) {
            let d = (w[0] as i32 - w[1] as i32).rem_euclid(8);
            assert!(d == 1 || d == 7, "ordre {ids:?}");
        }
    }

    /// Matrice routière où le trajet direct 1 ↔ 2 est interdit (pont bas) :
    /// le solveur doit suivre les vraies distances, pas le vol d'oiseau.
    #[test]
    fn suit_la_matrice_routiere() {
        let depot = Depot { adresse: "D".into(), lat: Some(48.0), lon: Some(-1.6) };
        // À vol d'oiseau, l'ordre naturel est 1, 2, 3 (alignés).
        let pts = vec![pt(1, 48.01, -1.6), pt(2, 48.02, -1.6), pt(3, 48.03, -1.6)];
        let ids = ["depot", "p1", "p2", "p3"];
        // Distances routières : passer 1 → 2 est très long (détour), 1 → 3 et 3 → 2 sont courts.
        let km = |a: usize, b: usize| -> f64 {
            let (a, b) = (a.min(b), a.max(b));
            match (a, b) {
                (0, 1) => 1.0, (0, 2) => 2.0, (0, 3) => 3.0,
                (1, 2) => 50.0, (1, 3) => 2.0, (2, 3) => 1.0,
                _ => 0.0,
            }
        };
        let distances = (0..4).map(|i| (0..4).map(|j| Some(km(i, j) * 1000.0)).collect()).collect();
        let durees = (0..4).map(|i| (0..4).map(|j| Some(km(i, j) * 60.0)).collect()).collect();
        let m = Matrice { ids: ids.iter().map(|s| s.to_string()).collect(), distances, durees };
        let t = calculer_avec(&depot, &pts, 300, Some(&m)).unwrap();
        let ordre: Vec<&str> = t.arrets.iter().map(|p| p.id.as_str()).collect();
        assert!(ordre == ["p1", "p3", "p2"] || ordre == ["p2", "p3", "p1"], "ordre {ordre:?}");
        assert_eq!(t.distances, "route");
        assert!((t.total_km - 6.0).abs() < 1e-9, "total {}", t.total_km);
        assert!(t.total_min.is_some());
    }

    #[test]
    fn signale_un_point_inaccessible() {
        let depot = Depot { adresse: "D".into(), lat: Some(48.0), lon: Some(-1.6) };
        let pts = vec![pt(1, 48.01, -1.6), pt(2, 48.02, -1.6)];
        let ids = ["depot", "p1", "p2"].iter().map(|s| s.to_string()).collect();
        // p2 est hors d'atteinte pour le camion.
        let ligne = |i: usize| (0..3).map(|j| if i == j { Some(0.0) } else if i == 2 || j == 2 { None } else { Some(1000.0) }).collect();
        let distances: Vec<Vec<Option<f64>>> = (0..3).map(ligne).collect();
        let m = Matrice { ids, durees: distances.clone(), distances };
        let t = calculer_avec(&depot, &pts, 100, Some(&m)).unwrap();
        assert_eq!(t.inaccessibles, vec!["p2".to_string()]);
        assert_eq!(t.distances, "mixte");
    }

    #[test]
    fn points_sans_position_ecartes() {
        let depot = Depot { adresse: "D".into(), lat: Some(48.0), lon: Some(-1.6) };
        let mut sans = pt(9, 0.0, 0.0);
        sans.lat = None;
        let t = calculer(&depot, &[pt(1, 48.01, -1.6), sans], 50).unwrap();
        assert_eq!(t.arrets.len(), 1);
        assert_eq!(t.non_places.len(), 1);
    }
}
