//! Géocodage avec la Base Adresse Nationale (service public, sans clé).
//!
//! Point d'accès principal : Géoplateforme de l'IGN. Repli : api-adresse.data.gouv.fr.
//! On peut forcer une autre URL avec la variable `TOURNEE_GEOCODER_URL` (tests).

use crate::model::{haversine, Depot, Point};
use serde::Deserialize;
use std::time::Duration;

pub use crate::SCORE_FIABLE;
/// Au-delà, un point trouvé loin du dépôt est considéré comme une erreur.
pub const RAYON_MAX_KM: f64 = 80.0;

#[derive(Debug, Clone)]
pub struct Resultat {
    pub lat: f64,
    pub lon: f64,
    pub label: String,
    pub score: f64,
}

#[derive(Deserialize)]
struct Reponse {
    #[serde(default)]
    features: Vec<Feature>,
}
#[derive(Deserialize)]
struct Feature {
    geometry: Geometry,
    #[serde(default)]
    properties: Props,
}
#[derive(Deserialize)]
struct Geometry {
    coordinates: Vec<f64>,
}
#[derive(Deserialize, Default)]
struct Props {
    #[serde(default)]
    label: String,
    #[serde(default)]
    score: f64,
}

pub struct Geocodeur {
    client: reqwest::Client,
    urls: Vec<String>,
}

impl Default for Geocodeur {
    fn default() -> Self {
        Self::new()
    }
}

impl Geocodeur {
    pub fn new() -> Self {
        let mut urls = vec![];
        if let Ok(u) = std::env::var("TOURNEE_GEOCODER_URL") {
            urls.push(u);
        } else {
            urls.push("https://data.geopf.fr/geocodage/search".into());
            urls.push("https://api-adresse.data.gouv.fr/search/".into());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("tournee-pav/0.1")
            .build()
            .expect("client http");
        Self { client, urls }
    }

    /// Cherche une adresse. `pres_de` oriente la recherche vers la zone du dépôt.
    pub async fn chercher(&self, q: &str, pres_de: Option<(f64, f64)>) -> Result<Option<Resultat>, String> {
        let q: String = q.chars().take(200).collect();
        if q.trim().len() < 3 {
            return Ok(None);
        }
        let mut derniere_erreur = String::new();
        for base in &self.urls {
            let mut params = vec![("q", q.clone()), ("limit", "1".into())];
            if base.contains("geopf") {
                params.push(("index", "address".into()));
            }
            if let Some((lat, lon)) = pres_de {
                params.push(("lat", format!("{lat:.5}")));
                params.push(("lon", format!("{lon:.5}")));
            }
            for essai in 0..3 {
                match self.client.get(base).query(&params).send().await {
                    Ok(r) if r.status().as_u16() == 429 => {
                        tokio::time::sleep(Duration::from_millis(800 * (essai + 1))).await;
                        derniere_erreur = "trop de requêtes".into();
                        continue;
                    }
                    Ok(r) if r.status().is_success() => {
                        let rep: Reponse = r.json().await.map_err(|e| e.to_string())?;
                        return Ok(rep.features.into_iter().next().and_then(|f| {
                            (f.geometry.coordinates.len() >= 2).then(|| Resultat {
                                lon: f.geometry.coordinates[0],
                                lat: f.geometry.coordinates[1],
                                label: f.properties.label,
                                score: f.properties.score,
                            })
                        }));
                    }
                    Ok(r) => {
                        derniere_erreur = format!("HTTP {}", r.status());
                        break;
                    }
                    Err(e) => {
                        derniere_erreur = e.to_string();
                        break;
                    }
                }
            }
        }
        Err(format!("Service d'adresses injoignable ({derniere_erreur})"))
    }

    /// Place le dépôt s'il n'a pas de position.
    pub async fn placer_depot(&self, depot: &mut Depot) -> Result<(), String> {
        if depot.position().is_some() {
            return Ok(());
        }
        match self.chercher(&depot.adresse, None).await? {
            Some(r) => {
                depot.lat = Some(r.lat);
                depot.lon = Some(r.lon);
                Ok(())
            }
            None => Err(format!("Dépôt introuvable : {}", depot.adresse)),
        }
    }

    /// Place les points qui n'ont pas de position. Renvoie le nombre de points placés.
    pub async fn placer_points(&self, points: &mut [Point], depot: Option<(f64, f64)>) -> Result<usize, String> {
        let mut n = 0;
        for p in points.iter_mut() {
            if p.position().is_some() {
                continue;
            }
            let q = p.requete();
            if let Some(r) = self.chercher(&q, depot).await? {
                let loin = depot.map(|d| haversine(d, (r.lat, r.lon)) > RAYON_MAX_KM).unwrap_or(false);
                p.label = r.label;
                p.score = Some(if loin { 0.0 } else { r.score });
                p.origine = "ban".into();
                if !loin {
                    p.lat = Some(r.lat);
                    p.lon = Some(r.lon);
                    n += 1;
                } else {
                    p.label = format!("{} (à plus de {RAYON_MAX_KM:.0} km du dépôt)", p.label);
                }
            } else {
                p.origine = "introuvable".into();
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        Ok(n)
    }
}
