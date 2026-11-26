use serde::{Deserialize, Serialize};

/// Un point de collecte (un arrêt du camion).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Point {
    pub id: String,
    pub adresse: String,
    pub code_postal: String,
    pub commune: String,
    pub flux: String,
    pub nb_bacs: Option<u32>,
    pub volume: String,
    pub reference: String,
    pub remarque: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// Adresse retrouvée par la BAN.
    pub label: String,
    /// Score BAN entre 0 et 1. `None` si la position vient de la fiche ou de l'utilisateur.
    pub score: Option<f64>,
    /// "fiche", "ban", "manuel" ou vide.
    pub origine: String,
    /// Nom du fichier d'où vient le point.
    pub source: String,
    /// Faut-il passer à ce point ?
    #[serde(default = "yes")]
    pub actif: bool,
}

fn yes() -> bool {
    true
}

impl Point {
    pub fn position(&self) -> Option<(f64, f64)> {
        match (self.lat, self.lon) {
            (Some(a), Some(b)) if a.is_finite() && b.is_finite() => Some((a, b)),
            _ => None,
        }
    }

    /// Texte envoyé au géocodeur.
    pub fn requete(&self) -> String {
        let ville = [self.code_postal.as_str(), self.commune.as_str()]
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        [self.adresse.as_str(), ville.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(", ")
    }

    /// Position jugée fiable ?
    pub fn fiable(&self) -> bool {
        match self.origine.as_str() {
            "fiche" | "manuel" => true,
            _ => self.score.map(|s| s >= crate::SCORE_FIABLE).unwrap_or(false),
        }
    }
}

/// Le dépôt : départ et retour du camion.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Depot {
    pub adresse: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
}

impl Depot {
    pub fn position(&self) -> Option<(f64, f64)> {
        match (self.lat, self.lon) {
            (Some(a), Some(b)) if a.is_finite() && b.is_finite() => Some((a, b)),
            _ => None,
        }
    }
}

/// Résultat du calcul de tournée.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Tournee {
    pub depot: Depot,
    /// Arrêts dans l'ordre de passage.
    pub arrets: Vec<Point>,
    /// Km estimés de chaque tronçon : dépôt → 1, 1 → 2, …, dernier → dépôt.
    pub troncons_km: Vec<f64>,
    pub total_km: f64,
    /// Points sans position, non inclus dans la tournée.
    pub non_places: Vec<Point>,
    pub methode: String,
    #[serde(default)]
    pub date: String,
}

/// Facteur appliqué à la distance à vol d'oiseau pour estimer la distance routière.
pub const FACTEUR_ROUTE: f64 = 1.3;

/// Distance à vol d'oiseau en km.
pub fn haversine(a: (f64, f64), b: (f64, f64)) -> f64 {
    let r = std::f64::consts::PI / 180.0;
    let (dlat, dlon) = ((b.0 - a.0) * r, (b.1 - a.1) * r);
    let h = (dlat / 2.0).sin().powi(2) + (a.0 * r).cos() * (b.0 * r).cos() * (dlon / 2.0).sin().powi(2);
    2.0 * 6371.0 * h.sqrt().asin()
}

/// Distance routière estimée en km.
pub fn km_route(a: (f64, f64), b: (f64, f64)) -> f64 {
    haversine(a, b) * FACTEUR_ROUTE
}

fn cle(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    s.nfd().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
}

/// Fusionne les points identiques (même adresse, commune et flux).
/// Même référence : c'est la même fiche lue deux fois, on garde un seul point.
/// Référence différente : deux emplacements au même endroit, on additionne les bacs.
pub fn fusionner_doublons(points: Vec<Point>) -> Vec<Point> {
    let mut out: Vec<Point> = vec![];
    for p in points {
        if p.adresse.trim().is_empty() {
            out.push(p);
            continue;
        }
        let k = (cle(&p.adresse), cle(&p.commune), cle(&p.flux));
        if let Some(q) = out.iter_mut().find(|q| (cle(&q.adresse), cle(&q.commune), cle(&q.flux)) == k) {
            let meme_fiche = !p.reference.is_empty() && p.reference == q.reference;
            if !meme_fiche {
                q.nb_bacs = match (q.nb_bacs, p.nb_bacs) {
                    (Some(a), Some(b)) => Some(a + b),
                    (a, b) => a.or(b),
                };
                if !p.reference.is_empty() && !q.reference.contains(&p.reference) {
                    q.reference = [q.reference.as_str(), p.reference.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(", ");
                }
            }
            if !p.remarque.is_empty() && !q.remarque.contains(&p.remarque) {
                q.remarque = [q.remarque.as_str(), p.remarque.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ; ");
            }
            if q.position().is_none() && p.position().is_some() {
                q.lat = p.lat;
                q.lon = p.lon;
                q.origine = p.origine.clone();
            }
            continue;
        }
        out.push(p);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn doublons() {
        let p = |r: &str, n| Point { adresse: "12 rue de Nantes".into(), commune: "Rennes".into(), flux: "Verre".into(), reference: r.into(), nb_bacs: Some(n), actif: true, ..Default::default() };
        // même fiche lue deux fois
        assert_eq!(fusionner_doublons(vec![p("R-1", 2), p("R-1", 2)])[0].nb_bacs, Some(2));
        // deux emplacements au même endroit
        let f = fusionner_doublons(vec![p("R-1", 2), p("R-2", 1)]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].nb_bacs, Some(3));
        assert_eq!(f[0].reference, "R-1, R-2");
    }
}
