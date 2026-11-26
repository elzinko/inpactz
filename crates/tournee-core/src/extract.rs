//! Lecture des fiches sans IA.
//!
//! - PDF avec texte : `pdf-extract` (Rust, open source).
//! - Photos et PDF scannés : OCR Tesseract (open source), appelé en ligne de commande.
//!   Pour les PDF scannés, les pages sont d'abord converties en images avec `pdftoppm` (Poppler).
//! - Le texte obtenu est découpé en points de collecte par [`analyser_texte`].
//!
//! Le découpage repose sur des règles (types de voie, code postal, flux, nombre de bacs,
//! coordonnées GPS). Il devra être ajusté au format réel des fiches.

use crate::model::Point;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
#[cfg(feature = "natif")]
use std::path::Path;
#[cfg(feature = "natif")]
use tokio::process::Command;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Serialize, Default)]
pub struct Lecture {
    pub fichier: String,
    /// "pdf-texte", "ocr", ou "echec"
    pub methode: String,
    pub points: Vec<Point>,
    pub texte: String,
    pub avertissement: Option<String>,
}

/// Lit un fichier (PDF ou image) et renvoie les points trouvés.
#[cfg(feature = "natif")]
pub async fn lire_fichier(nom: &str, octets: &[u8]) -> Lecture {
    let mut l = Lecture { fichier: nom.to_string(), ..Default::default() };
    let est_pdf = octets.starts_with(b"%PDF") || nom.to_lowercase().ends_with(".pdf");
    let texte = if est_pdf {
        let t = match pdftotext(octets).await {
            Some(t) => t,
            None => pdf_extract::extract_text_from_mem(octets).unwrap_or_default(),
        };
        if t.chars().filter(|c| c.is_alphanumeric()).count() >= 30 {
            l.methode = "pdf-texte".into();
            Ok(t)
        } else {
            l.methode = "ocr".into();
            ocr_pdf(octets).await
        }
    } else {
        l.methode = "ocr".into();
        ocr_image(octets, nom).await
    };
    match texte {
        Ok(t) => {
            l.points = analyser_texte(&t, nom);
            if l.points.is_empty() {
                l.avertissement = Some("Aucune adresse reconnue dans ce fichier.".into());
            }
            l.texte = t;
        }
        Err(e) => {
            l.methode = "echec".into();
            l.avertissement = Some(e);
        }
    }
    l
}

#[cfg(feature = "natif")]
/// Texte d'un PDF avec Poppler (`pdftotext -layout`), qui garde les colonnes séparées.
async fn pdftotext(octets: &[u8]) -> Option<String> {
    let dir = tempfile::tempdir().ok()?;
    let pdf = dir.path().join("fiche.pdf");
    tokio::fs::write(&pdf, octets).await.ok()?;
    let out = Command::new("pdftotext").args(["-layout", "-enc", "UTF-8"]).arg(&pdf).arg("-").output().await.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(feature = "natif")]
async fn ocr_image(octets: &[u8], nom: &str) -> Result<String, String> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let ext = Path::new(nom).extension().and_then(|e| e.to_str()).unwrap_or("img").to_lowercase();
    if ext == "heic" || ext == "heif" {
        return Err("Format HEIC non pris en charge : exporte la photo en JPEG.".into());
    }
    let chemin = dir.path().join(format!("fiche.{ext}"));
    tokio::fs::write(&chemin, octets).await.map_err(|e| e.to_string())?;
    tesseract(&chemin).await
}

#[cfg(feature = "natif")]
async fn ocr_pdf(octets: &[u8]) -> Result<String, String> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let pdf = dir.path().join("fiche.pdf");
    tokio::fs::write(&pdf, octets).await.map_err(|e| e.to_string())?;
    let sortie = dir.path().join("page");
    let st = Command::new("pdftoppm")
        .args(["-r", "300", "-png", "-l", "30"])
        .arg(&pdf)
        .arg(&sortie)
        .status()
        .await
        .map_err(|_| "PDF scanné : l'outil pdftoppm (Poppler) n'est pas installé sur le serveur.".to_string())?;
    if !st.success() {
        return Err("PDF illisible.".into());
    }
    let mut pages: Vec<_> = std::fs::read_dir(dir.path())
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "png").unwrap_or(false))
        .collect();
    pages.sort();
    let mut texte = String::new();
    for p in pages {
        texte.push_str(&tesseract(&p).await?);
        texte.push('\n');
    }
    Ok(texte)
}

#[cfg(feature = "natif")]
async fn tesseract(image: &Path) -> Result<String, String> {
    let out = Command::new("tesseract")
        .arg(image)
        .arg("stdout")
        .args(["-l", "fra", "--psm", "4"])
        .output()
        .await
        .map_err(|_| "OCR : Tesseract n'est pas installé sur le serveur.".to_string())?;
    if !out.status.success() {
        return Err(format!("OCR en échec : {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ------------------------------------------------------------------ analyse du texte

const VOIES: &str = r"rue|r\.|avenue|av\.?|boulevard|bd|bld|place|pl\.|chemin|ch\.|chem\.?|all[ée]e|impasse|imp\.?|route|rte|quai|cours|square|sq\.|passage|lotissement|lot\.|r[ée]sidence|cit[ée]|hameau|lieu[- ]dit|l\.?d\.|parking|esplanade|promenade|rond[- ]point|carrefour|sentier|voie|zone|za|zi|zac|parc|faubourg|fg|mail|venelle|ruelle|clos|domaine|mont[ée]e|c[ôo]te|square|village|quartier|hameau";

static RE_VOIE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(r"(?i)(?:^|[\s,;|(])((?:\d{{1,4}}\s?(?:bis|ter|[a-d])?\s*,?\s+)?(?:{VOIES})\s)")).unwrap()
});
/// Mots qui marquent la fin d'une adresse dans une ligne de tableau.
static RE_FIN_ADRESSE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\s{2,}|\t|[|;]|,\s*\d{5}|\s\d|\s-\s|\s(?:verre|emballages?|papiers?|cartons?|ordures|om|omr|bio\S*|textiles?|recyclables?|bacs?|colonnes?|conteneurs?|acc[eè]s|attention|horaires?)\b").unwrap()
});
static RE_CP_VILLE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(\d{5})\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' \-]{1,40}?)(?:\s{2,}|\t|;|\||,|$)").unwrap());
static RE_COMMUNE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b(?:commune|ville|localit[ée])\s*:?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' \-]{1,40})").unwrap());
static RE_GPS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(-?\d{1,2}[.,]\d{3,})\s*[,;/ ]\s*(-?\d{1,3}[.,]\d{3,})").unwrap());
static RE_BACS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:\b(\d{1,2})\s*(?:x\s*)?(?:bacs?|colonnes?|conteneurs?|containers?|cuves?|pav)\b)|(?:\b(?:nb|nombre)\s*(?:de\s*)?(?:bacs?|colonnes?|conteneurs?)\s*:?\s*(\d{1,2})\b)").unwrap()
});
static RE_VOLUME: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(\d+(?:[.,]\d+)?)\s*(m3|m³|litres|l)\b").unwrap());
static RE_REMARQUE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:acc[eè]s|attention|horaires?|avant\s|apr[eè]s\s|code\s|portail|cl[eé]\s|stationnement|remarque|observation|interdit|sauf)").unwrap()
});
static RE_REF_DEBUT: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*([A-Z]{1,4}[-_ ]?\d{1,6})\b").unwrap());
static RE_REF: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b(?:r[ée]f(?:[ée]rence)?|n°\s*pav|id|code)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{1,15})").unwrap());

fn trouver_adresse(ligne: &str) -> Option<String> {
    let c = RE_VOIE.captures(ligne)?;
    let debut = c.get(1)?.start();
    let apres_voie = c.get(1)?.end();
    let reste = &ligne[apres_voie..];
    let fin = RE_FIN_ADRESSE.find(reste).map(|m| m.start()).unwrap_or(reste.len());
    let a = propre(&ligne[debut..apres_voie + fin]);
    // Il faut au moins un mot après le type de voie.
    (a.split_whitespace().count() >= 2 && a.chars().filter(|c| c.is_alphabetic()).count() >= 6).then_some(a)
}

fn sans_accents(s: &str) -> String {
    s.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect::<String>().to_lowercase()
}

fn flux_de(ligne: &str) -> Option<&'static str> {
    let l = sans_accents(ligne);
    let a = |m: &str| Regex::new(&format!(r"\b(?:{m})")).unwrap().is_match(&l);
    if a("verre") {
        Some("Verre")
    } else if a("emballage|recyclable|multimateriau|bac jaune|cs\\b|collecte selective") {
        Some("Emballages")
    } else if a("papier|journaux|jrm") {
        Some("Papier")
    } else if a("carton") {
        Some("Cartons")
    } else if a("biodechet|bio-dechet|fermentescible|alimentaire") {
        Some("Biodéchets")
    } else if a("ordure|om\\b|omr|residuel|tout venant") {
        Some("Ordures ménagères")
    } else if a("textile|tlc|vetement") {
        Some("Textile")
    } else {
        None
    }
}

fn en_coord(s: &str) -> Option<f64> {
    s.replace(',', ".").parse().ok()
}

fn propre(s: &str) -> String {
    s.trim().trim_matches(|c: char| c == ',' || c == '-' || c == ':' || c == '.').split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Découpe le texte d'une fiche en points de collecte.
pub fn analyser_texte(texte: &str, source: &str) -> Vec<Point> {
    let commune_globale = RE_COMMUNE.captures(texte).map(|c| propre(&c[1]));
    let cp_global = RE_CP_VILLE.captures(texte).map(|c| (c[1].to_string(), propre(&c[2])));

    let mut points: Vec<Point> = vec![];
    for brute in texte.lines() {
        let ligne = brute.replace('\u{a0}', " ");
        if ligne.trim().is_empty() {
            continue;
        }
        let adresse = trouver_adresse(&ligne);
        let gps = RE_GPS.captures(&ligne).and_then(|c| {
            let (a, b) = (en_coord(&c[1])?, en_coord(&c[2])?);
            ((41.0..52.0).contains(&a) && (-6.0..10.0).contains(&b)).then_some((a, b))
        });

        if adresse.is_some() || (gps.is_some() && points.last().map(|p| p.lat.is_some()).unwrap_or(true)) {
            points.push(Point {
                id: format!("{}-{}", source, points.len() + 1),
                adresse: adresse.clone().unwrap_or_default(),
                source: source.to_string(),
                actif: true,
                ..Default::default()
            });
        }
        let Some(p) = points.last_mut() else { continue };

        if let Some(c) = RE_CP_VILLE.captures(&ligne) {
            if p.code_postal.is_empty() {
                p.code_postal = c[1].to_string();
                p.commune = propre(&c[2]);
            }
        }
        if let Some((a, b)) = gps {
            if p.lat.is_none() {
                p.lat = Some(a);
                p.lon = Some(b);
                p.origine = "fiche".into();
            }
        }
        if p.flux.is_empty() {
            if let Some(f) = flux_de(&ligne) {
                p.flux = f.into();
            }
        }
        if p.nb_bacs.is_none() {
            if let Some(c) = RE_BACS.captures(&ligne) {
                p.nb_bacs = c.get(1).or(c.get(2)).and_then(|m| m.as_str().parse().ok());
            }
        }
        if p.volume.is_empty() {
            if let Some(c) = RE_VOLUME.captures(&ligne) {
                p.volume = format!("{} {}", &c[1], &c[2]);
            }
        }
        if p.reference.is_empty() {
            if let Some(c) = RE_REF_DEBUT.captures(&ligne).or_else(|| RE_REF.captures(&ligne)) {
                p.reference = c[1].to_string();
            }
        }
        if let Some(m) = RE_REMARQUE.find(&ligne) {
            let r = propre(ligne[m.start()..].split(['|', '\t']).next().unwrap_or(""));
            let r = r.split("   ").next().unwrap_or("").trim().to_string();
            if !r.is_empty() && !p.remarque.contains(&r) {
                p.remarque = if p.remarque.is_empty() { r } else { format!("{} ; {r}", p.remarque) };
                p.remarque = p.remarque.chars().take(160).collect();
            }
        }
    }

    for p in &mut points {
        if p.commune.is_empty() {
            if let Some(c) = &commune_globale {
                p.commune = c.clone();
            } else if let Some((cp, v)) = &cp_global {
                p.code_postal = cp.clone();
                p.commune = v.clone();
            }
        }
    }
    points
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tableau_simple() {
        let t = "Fiche de rotation PAV - Commune : Rennes\n\
                 Adresse   Flux   Nb bacs\n\
                 12 rue de Nantes   Verre   2 bacs\n\
                 Place de la République  Emballages  3 colonnes\n\
                 Accès par l'arrière du parking\n\
                 Chemin des Prés, 35510 Cesson-Sévigné  Papier  1 bac  48.1201, -1.6034\n";
        let p = analyser_texte(t, "f.pdf");
        assert_eq!(p.len(), 3, "{p:#?}");
        assert_eq!(p[0].adresse, "12 rue de Nantes");
        assert_eq!(p[0].flux, "Verre");
        assert_eq!(p[0].nb_bacs, Some(2));
        assert_eq!(p[0].commune, "Rennes");
        assert_eq!(p[1].adresse, "Place de la République");
        assert_eq!(p[1].nb_bacs, Some(3));
        assert!(p[1].remarque.contains("arrière"));
        assert_eq!(p[2].code_postal, "35510");
        assert_eq!(p[2].lat, Some(48.1201));
    }
}
