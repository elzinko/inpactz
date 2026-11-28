//! Interface JavaScript du moteur de tournée. Les données passent en JSON.
//! Tout tourne sur l'appareil : aucun serveur n'est nécessaire, sauf la Base
//! Adresse Nationale pour placer les adresses (appelée par l'appli).

use tournee_core::{extract, solve, tableur, xlsx, Depot, Matrice, Point, Tournee};
use wasm_bindgen::prelude::*;

fn js<T: serde::Serialize>(v: &T) -> Result<String, JsError> {
    serde_json::to_string(v).map_err(|e| JsError::new(&e.to_string()))
}
fn lire<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, JsError> {
    serde_json::from_str(s).map_err(|e| JsError::new(&format!("données invalides : {e}")))
}

#[wasm_bindgen(start)]
pub fn demarrer() {
    console_error_panic_hook::set_once();
}

/// Texte d'une fiche (PDF ou OCR) → points (JSON).
#[wasm_bindgen]
pub fn analyser_texte(texte: &str, source: &str) -> Result<String, JsError> {
    js(&extract::analyser_texte(texte, source))
}

/// Fichier Excel / ODS → points (JSON).
#[wasm_bindgen]
pub fn lire_classeur(octets: &[u8], source: &str) -> Result<String, JsError> {
    js(&tableur::lire_classeur(octets, source).map_err(|e| JsError::new(&e))?)
}

/// Fichier CSV → points (JSON).
#[wasm_bindgen]
pub fn lire_csv(texte: &str, source: &str) -> Result<String, JsError> {
    js(&tableur::lire_csv(texte, source))
}

/// Fusionne les doublons.
#[wasm_bindgen]
pub fn fusionner(points: &str) -> Result<String, JsError> {
    js(&tournee_core::fusionner_doublons(lire::<Vec<Point>>(points)?))
}

#[derive(serde::Serialize)]
struct Reponse {
    #[serde(flatten)]
    tournee: Tournee,
    liens: Vec<(String, String)>,
}

/// Matrice routière facultative : chaîne vide → estimation à vol d'oiseau.
fn matrice(m: &str) -> Result<Option<Matrice>, JsError> {
    if m.trim().is_empty() { Ok(None) } else { lire(m).map(Some) }
}

/// Calcule l'ordre de passage (dépôt et points en JSON). `matrice` : distances routières
/// du camion (JSON [`Matrice`]) ou chaîne vide.
#[wasm_bindgen]
pub fn calculer(depot: &str, points: &str, date: &str, generations: usize, matrice_json: &str) -> Result<String, JsError> {
    let m = matrice(matrice_json)?;
    let mut t = solve::calculer_avec(&lire::<Depot>(depot)?, &lire::<Vec<Point>>(points)?, generations, m.as_ref()).map_err(|e| JsError::new(&e))?;
    t.date = date.to_string();
    js(&Reponse { liens: xlsx::liens_itineraire(&t), tournee: t })
}

/// Recalcule les distances après un changement d'ordre à la main.
#[wasm_bindgen]
pub fn recalculer(depot: &str, arrets: &str, non_places: &str, date: &str, matrice_json: &str) -> Result<String, JsError> {
    let m = matrice(matrice_json)?;
    let mut t = solve::recalculer_avec(&lire::<Depot>(depot)?, lire::<Vec<Point>>(arrets)?, m.as_ref()).map_err(|e| JsError::new(&e))?;
    t.non_places = lire(non_places)?;
    t.date = date.to_string();
    js(&Reponse { liens: xlsx::liens_itineraire(&t), tournee: t })
}

/// Feuille de route Excel (octets .xlsx).
#[wasm_bindgen]
pub fn excel(tournee: &str) -> Result<Vec<u8>, JsError> {
    xlsx::generer(&lire::<Tournee>(tournee)?).map_err(|e| JsError::new(&e.to_string()))
}
