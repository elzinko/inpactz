//! Ordre de passage : problème du voyageur de commerce résolu par `vrp-pragmatic`
//! (solveur open source de tournées, licence Apache 2.0). Aucun LLM.

use crate::model::{km_route, Depot, Point, Tournee};
use std::collections::HashMap;
use std::io::BufWriter;
use std::sync::Arc;
use vrp_core::solver::{Solver, VrpConfigBuilder};
use vrp_core::utils::Environment;
use vrp_pragmatic::format::problem::PragmaticProblem;
use vrp_pragmatic::format::solution::{write_pragmatic, PragmaticOutputType};

/// Calcule la tournée : départ du dépôt, tous les points actifs placés, retour au dépôt.
pub fn calculer(depot: &Depot, points: &[Point], generations: usize) -> Result<Tournee, String> {
    let d = depot.position().ok_or("Le dépôt n'a pas de position.")?;
    let actifs: Vec<&Point> = points.iter().filter(|p| p.actif).collect();
    let (places, non_places): (Vec<&Point>, Vec<&Point>) = actifs.into_iter().partition(|p| p.position().is_some());

    let (ordre, methode) = match places.len() {
        0 => (vec![], "aucun point".to_string()),
        1 => (vec![0], "un seul point".to_string()),
        _ => (resoudre(d, &places, generations)?, "vrp-pragmatic".to_string()),
    };

    let arrets: Vec<Point> = ordre.iter().map(|&i| places[i].clone()).collect();
    let mut seq = vec![d];
    seq.extend(arrets.iter().map(|p| p.position().unwrap()));
    seq.push(d);
    let troncons_km: Vec<f64> = seq.windows(2).map(|w| km_route(w[0], w[1])).collect();
    let total_km = troncons_km.iter().sum();

    Ok(Tournee {
        depot: depot.clone(),
        arrets,
        troncons_km,
        total_km,
        non_places: non_places.into_iter().cloned().collect(),
        methode,
        date: String::new(),
    })
}

/// Renvoie l'ordre de visite (indices dans `places`).
fn resoudre(depot: (f64, f64), places: &[&Point], generations: usize) -> Result<Vec<usize>, String> {
    // Matrice des distances (mètres) et durées (secondes, 30 km/h moyen).
    let mut locs = vec![depot];
    locs.extend(places.iter().map(|p| p.position().unwrap()));
    let n = locs.len();
    let mut distances = Vec::with_capacity(n * n);
    let mut durees = Vec::with_capacity(n * n);
    for a in &locs {
        for b in &locs {
            let m = (km_route(*a, *b) * 1000.0).round() as i64;
            distances.push(m);
            durees.push(m * 120 / 1000); // 30 km/h
        }
    }
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
    let d = depot.position().ok_or("Le dépôt n'a pas de position.")?;
    let mut seq = vec![d];
    seq.extend(arrets.iter().filter_map(|p| p.position()));
    seq.push(d);
    let troncons_km: Vec<f64> = seq.windows(2).map(|w| km_route(w[0], w[1])).collect();
    Ok(Tournee {
        depot: depot.clone(),
        total_km: troncons_km.iter().sum(),
        troncons_km,
        arrets,
        non_places: vec![],
        methode: "ordre modifié à la main".into(),
        date: String::new(),
    })
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
