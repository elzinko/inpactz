//! Lecture d'un fichier Excel (.xlsx, .xls, .ods) ou CSV contenant des adresses.
//!
//! Les colonnes sont reconnues par leur titre (adresse, code postal, commune, flux,
//! bacs, GPS…). S'il n'y a pas de titre reconnu, chaque ligne est analysée comme du
//! texte avec les mêmes règles que les fiches PDF.

use crate::extract::analyser_texte;
use crate::model::Point;
use calamine::{open_workbook_auto_from_rs, Data, Reader};
use std::io::Cursor;
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Col {
    Adresse,
    Numero,
    Voie,
    CodePostal,
    Commune,
    Flux,
    Bacs,
    Volume,
    Reference,
    Remarque,
    Lat,
    Lon,
    Gps,
}

fn norm(s: &str) -> String {
    s.nfd().filter(|c| c.is_alphanumeric() || *c == ' ').collect::<String>().to_lowercase().trim().to_string()
}

fn colonne(titre: &str) -> Option<Col> {
    let t = norm(titre);
    let a = |mots: &[&str]| mots.iter().any(|m| t == *m || t.starts_with(&format!("{m} ")) || t.contains(m));
    Some(if t.is_empty() {
        return None;
    } else if a(&["latitude"]) || t == "lat" || t == "y" {
        Col::Lat
    } else if a(&["longitude"]) || t == "lon" || t == "lng" || t == "long" || t == "x" {
        Col::Lon
    } else if a(&["gps", "coordonnee"]) {
        Col::Gps
    } else if a(&["code postal", "codepostal"]) || t == "cp" {
        Col::CodePostal
    } else if a(&["commune", "ville", "localite"]) {
        Col::Commune
    } else if a(&["adresse", "emplacement", "localisation", "lieu"]) {
        Col::Adresse
    } else if t == "n" || t == "numero" || t == "no" || t == "num" {
        Col::Numero
    } else if a(&["rue", "voie"]) {
        Col::Voie
    } else if a(&["flux", "type de dechet", "dechet", "materiau", "matiere"]) {
        Col::Flux
    } else if a(&["bac", "colonne", "conteneur", "quantite", "nombre", "nb"]) {
        Col::Bacs
    } else if a(&["volume", "capacite", "contenance"]) {
        Col::Volume
    } else if a(&["reference", "ref", "identifiant", "id", "code pav", "n pav", "numero pav"]) {
        Col::Reference
    } else if a(&["remarque", "observation", "commentaire", "note", "consigne", "acces"]) {
        Col::Remarque
    } else {
        return None;
    })
}

fn texte(c: &Data) -> String {
    match c {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Float(f) if f.fract() == 0.0 => format!("{}", *f as i64),
        Data::Float(f) => format!("{f}"),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn nombre(s: &str) -> Option<f64> {
    s.trim().replace(',', ".").parse().ok()
}

/// Transforme des lignes (première ligne utile = titres) en points.
pub fn lignes_en_points(lignes: Vec<Vec<String>>, source: &str) -> Vec<Point> {
    // Cherche la ligne de titres dans les 10 premières lignes.
    let mut titres: Option<(usize, Vec<Option<Col>>)> = None;
    for (i, l) in lignes.iter().take(10).enumerate() {
        // Si deux colonnes ont le même rôle, la première l'emporte.
        let mut vus = vec![];
        let cols: Vec<Option<Col>> = l
            .iter()
            .map(|c| colonne(c).filter(|k| if vus.contains(k) { false } else { vus.push(*k); true }))
            .collect();
        let utiles = cols.iter().filter(|c| c.is_some()).count();
        let a_adresse = cols.iter().any(|c| matches!(c, Some(Col::Adresse | Col::Voie | Col::Commune | Col::Lat)));
        if utiles >= 2 && a_adresse {
            titres = Some((i, cols));
            break;
        }
    }
    let Some((debut, cols)) = titres else {
        // Pas de titres : on analyse chaque ligne comme du texte.
        let texte = lignes.iter().map(|l| l.join("   ")).collect::<Vec<_>>().join("\n");
        return analyser_texte(&texte, source);
    };

    let mut points = vec![];
    for (n, l) in lignes.iter().enumerate().skip(debut + 1) {
        let mut p = Point { id: format!("{source}-{}", n + 1), source: source.to_string(), actif: true, ..Default::default() };
        let (mut numero, mut voie) = (String::new(), String::new());
        for (i, v) in l.iter().enumerate() {
            let v = v.trim();
            if v.is_empty() {
                continue;
            }
            match cols.get(i).copied().flatten() {
                Some(Col::Adresse) => p.adresse = v.to_string(),
                Some(Col::Numero) => numero = v.to_string(),
                Some(Col::Voie) => voie = v.to_string(),
                Some(Col::CodePostal) => p.code_postal = v.to_string(),
                Some(Col::Commune) => p.commune = v.to_string(),
                Some(Col::Flux) => p.flux = v.to_string(),
                Some(Col::Bacs) => p.nb_bacs = nombre(v).map(|x| x as u32),
                Some(Col::Volume) => p.volume = v.to_string(),
                Some(Col::Reference) => p.reference = v.to_string(),
                Some(Col::Remarque) => p.remarque = v.to_string(),
                Some(Col::Lat) => p.lat = nombre(v),
                Some(Col::Lon) => p.lon = nombre(v),
                Some(Col::Gps) => {
                    let parts: Vec<f64> = v.split([',', ';', ' ']).filter_map(nombre).collect();
                    if parts.len() == 2 {
                        p.lat = Some(parts[0]);
                        p.lon = Some(parts[1]);
                    }
                }
                None => {}
            }
        }
        if p.adresse.is_empty() && !voie.is_empty() {
            p.adresse = [numero.as_str(), voie.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" ");
        }
        if p.position().is_some() {
            p.origine = "fiche".into();
        } else {
            p.lat = None;
            p.lon = None;
        }
        if !p.adresse.is_empty() || !p.commune.is_empty() || p.position().is_some() {
            points.push(p);
        }
    }
    points
}

/// Lit un classeur (xlsx, xls, xlsb, ods) : toutes les feuilles.
pub fn lire_classeur(octets: &[u8], source: &str) -> Result<Vec<Point>, String> {
    let mut wb = open_workbook_auto_from_rs(Cursor::new(octets.to_vec())).map_err(|e| format!("Classeur illisible : {e}"))?;
    let mut points = vec![];
    for nom in wb.sheet_names().to_owned() {
        if let Ok(plage) = wb.worksheet_range(&nom) {
            let lignes: Vec<Vec<String>> = plage.rows().map(|r| r.iter().map(texte).collect()).collect();
            points.extend(lignes_en_points(lignes, source));
        }
    }
    Ok(points)
}

/// Lit un CSV (séparateur ; , ou tabulation).
pub fn lire_csv(texte: &str, source: &str) -> Vec<Point> {
    let texte = texte.trim_start_matches('\u{feff}');
    let entete = texte.lines().next().unwrap_or("");
    let sep = [';', '\t', ','].into_iter().max_by_key(|c| entete.matches(*c).count()).unwrap_or(';');
    let lignes = texte.lines().map(|l| decouper_csv(l, sep)).collect();
    lignes_en_points(lignes, source)
}

fn decouper_csv(l: &str, sep: char) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut guillemets = false;
    let mut it = l.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '"' if guillemets && it.peek() == Some(&'"') => {
                cur.push('"');
                it.next();
            }
            '"' => guillemets = !guillemets,
            c if c == sep && !guillemets => out.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    out.push(cur);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_avec_titres() {
        let t = "N° PAV;Adresse;CP;Ville;Flux;Nb bacs;Observations;Latitude;Longitude\n\
                 R1;12 rue de Nantes;35000;Rennes;Verre;2;;;\n\
                 R2;Place Sainte-Anne;35000;Rennes;Papier;1;Avant 10h;48,1147;-1,68\n";
        let p = lire_csv(t, "t.csv");
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].adresse, "12 rue de Nantes");
        assert_eq!(p[0].reference, "R1");
        assert_eq!(p[0].nb_bacs, Some(2));
        assert_eq!(p[1].lat, Some(48.1147));
        assert_eq!(p[1].origine, "fiche");
        assert_eq!(p[1].remarque, "Avant 10h");
    }

    #[test]
    fn numero_et_voie_separes() {
        let l = vec![
            vec!["Numéro".into(), "Rue".into(), "Commune".into()],
            vec!["5".into(), "rue du Bignon".into(), "Rennes".into()],
        ];
        let p = lignes_en_points(l, "x");
        assert_eq!(p[0].adresse, "5 rue du Bignon");
    }
}
