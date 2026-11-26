//! Feuille de route Excel (rust_xlsxwriter, open source).

use crate::model::{Point, Tournee};
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Url, Workbook, XlsxError};

fn lien_point(lat: f64, lon: f64) -> String {
    format!("https://www.google.com/maps/search/?api=1&query={lat:.6},{lon:.6}")
}

/// Liens d'itinéraire Google Maps, par tronçons de 8 arrêts (limite des liens Google Maps).
pub fn liens_itineraire(t: &Tournee) -> Vec<(String, String)> {
    let Some(d) = t.depot.position() else { return vec![] };
    let mut seq = vec![d];
    seq.extend(t.arrets.iter().filter_map(|p| p.position()));
    seq.push(d);
    let q = |c: (f64, f64)| format!("{:.6},{:.6}", c.0, c.1);
    let mut out = vec![];
    let mut s = 0;
    while s + 1 < seq.len() {
        let fin = (s + 9).min(seq.len() - 1);
        let bloc = &seq[s..=fin];
        let mut url = format!(
            "https://www.google.com/maps/dir/?api=1&travelmode=driving&origin={}&destination={}",
            q(bloc[0]),
            q(*bloc.last().unwrap())
        );
        if bloc.len() > 2 {
            let w: Vec<String> = bloc[1..bloc.len() - 1].iter().map(|c| q(*c)).collect();
            url.push_str("&waypoints=");
            url.push_str(&urlencoding::encode(&w.join("|")));
        }
        let de = if s == 0 { "Départ".to_string() } else { format!("Arrêt {s}") };
        let a = if fin == seq.len() - 1 { "Retour dépôt".to_string() } else { format!("Arrêt {fin}") };
        out.push((format!("{de} → {a}"), url));
        s = fin;
    }
    out
}

pub fn generer(t: &Tournee) -> Result<Vec<u8>, XlsxError> {
    let mut wb = Workbook::new();
    let entete = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x17251F))
        .set_text_wrap()
        .set_align(FormatAlign::VerticalCenter);
    let titre = Format::new().set_bold().set_font_size(14);
    let bord = Format::new().set_border_bottom(FormatBorder::Thin).set_border_bottom_color(Color::RGB(0xD5DDD8)).set_align(FormatAlign::Top);
    let enrob = bord.clone().set_text_wrap();
    let depot_f = bord.clone().set_background_color(Color::RGB(0xF2A900));
    let alerte = bord.clone().set_background_color(Color::RGB(0xFFF4E0));
    let alerte_enrob = alerte.clone().set_text_wrap();

    let ws = wb.add_worksheet();
    ws.set_name("Tournée")?;
    let bacs: u32 = t.arrets.iter().filter_map(|p| p.nb_bacs).sum();
    ws.write_string_with_format(0, 0, format!("Tournée PAV{}", if t.date.is_empty() { String::new() } else { format!(" du {}", t.date) }), &titre)?;
    ws.write_string(1, 0, format!("{} arrêts · {} bacs · environ {:.1} km · calcul : {}", t.arrets.len(), bacs, t.total_km, t.methode))?;
    ws.write_string(2, 0, format!("Départ et retour : {}", t.depot.adresse))?;

    let cols = [
        ("Fait", 6.0), ("Ordre", 7.0), ("Adresse", 34.0), ("Code postal", 11.0), ("Commune", 18.0), ("Flux", 16.0),
        ("Bacs", 6.0), ("Volume", 9.0), ("Référence", 12.0), ("Remarque", 30.0), ("Adresse trouvée", 38.0),
        ("Fiabilité", 10.0), ("Latitude", 11.0), ("Longitude", 11.0), ("Km depuis l'arrêt précédent", 12.0),
        ("Google Maps", 12.0), ("Fiche source", 22.0),
    ];
    let r0 = 4u32;
    for (c, (h, w)) in cols.iter().enumerate() {
        ws.write_string_with_format(r0, c as u16, *h, &entete)?;
        ws.set_column_width(c as u16, *w)?;
    }
    ws.set_row_height(r0, 30)?;

    let mut r = r0;
    let ligne_depot = |ws: &mut rust_xlsxwriter::Worksheet, r: u32, libelle: &str, km: Option<f64>| -> Result<(), XlsxError> {
        for c in 0..cols.len() as u16 {
            ws.write_blank(r, c, &depot_f)?;
        }
        ws.write_string_with_format(r, 1, "D", &depot_f)?;
        ws.write_string_with_format(r, 2, &t.depot.adresse, &depot_f)?;
        ws.write_string_with_format(r, 5, libelle, &depot_f)?;
        if let Some((la, lo)) = t.depot.position() {
            ws.write_number_with_format(r, 12, la, &depot_f)?;
            ws.write_number_with_format(r, 13, lo, &depot_f)?;
            ws.write_url_with_format(r, 15, Url::new(lien_point(la, lo)).set_text("Ouvrir"), &depot_f)?;
        }
        if let Some(k) = km {
            ws.write_number_with_format(r, 14, (k * 10.0).round() / 10.0, &depot_f)?;
        }
        Ok(())
    };
    r += 1;
    ligne_depot(ws, r, "Départ", None)?;
    for (i, p) in t.arrets.iter().enumerate() {
        r += 1;
        let (f, fw) = if p.fiable() { (&bord, &enrob) } else { (&alerte, &alerte_enrob) };
        ligne_point(ws, r, i, p, t.troncons_km.get(i).copied(), f, fw)?;
    }
    r += 1;
    ligne_depot(ws, r, "Retour", t.troncons_km.last().copied())?;
    ws.set_freeze_panes(r0 + 1, 3)?;
    ws.autofilter(r0, 0, r, cols.len() as u16 - 1)?;
    ws.set_landscape();
    ws.set_print_fit_to_pages(1, 0);
    ws.set_repeat_rows(r0, r0)?;

    // Itinéraire
    let it = wb.add_worksheet();
    it.set_name("Itinéraire")?;
    it.write_string_with_format(0, 0, "Itinéraire à ouvrir dans Google Maps (tronçons de 8 arrêts)", &titre)?;
    for (i, (lib, url)) in liens_itineraire(t).iter().enumerate() {
        it.write_string(2 + i as u32, 0, lib)?;
        it.write_url(2 + i as u32, 1, Url::new(url.as_str()).set_text("Ouvrir l'itinéraire"))?;
    }
    it.set_column_width(0, 28)?;
    it.set_column_width(1, 24)?;

    // À vérifier
    if !t.non_places.is_empty() {
        let ko = wb.add_worksheet();
        ko.set_name("À vérifier")?;
        let h = ["Adresse", "Code postal", "Commune", "Flux", "Bacs", "Remarque", "Problème", "Fiche source"];
        for (c, x) in h.iter().enumerate() {
            ko.write_string_with_format(0, c as u16, *x, &entete)?;
        }
        for (i, p) in t.non_places.iter().enumerate() {
            let r = 1 + i as u32;
            ko.write_string(r, 0, &p.adresse)?;
            ko.write_string(r, 1, &p.code_postal)?;
            ko.write_string(r, 2, &p.commune)?;
            ko.write_string(r, 3, &p.flux)?;
            if let Some(n) = p.nb_bacs {
                ko.write_number(r, 4, n)?;
            }
            ko.write_string(r, 5, &p.remarque)?;
            ko.write_string(r, 6, if p.label.is_empty() { "adresse introuvable".to_string() } else { p.label.clone() })?;
            ko.write_string(r, 7, &p.source)?;
        }
        for (c, w) in [34.0, 11.0, 18.0, 16.0, 6.0, 30.0, 40.0, 22.0].iter().enumerate() {
            ko.set_column_width(c as u16, *w)?;
        }
    }
    wb.save_to_buffer()
}

fn ligne_point(
    ws: &mut rust_xlsxwriter::Worksheet,
    r: u32,
    i: usize,
    p: &Point,
    km: Option<f64>,
    f: &Format,
    fw: &Format,
) -> Result<(), XlsxError> {
    ws.write_string_with_format(r, 0, "☐", f)?;
    ws.write_number_with_format(r, 1, (i + 1) as f64, f)?;
    ws.write_string_with_format(r, 2, &p.adresse, fw)?;
    ws.write_string_with_format(r, 3, &p.code_postal, f)?;
    ws.write_string_with_format(r, 4, &p.commune, f)?;
    ws.write_string_with_format(r, 5, &p.flux, f)?;
    match p.nb_bacs {
        Some(n) => ws.write_number_with_format(r, 6, n, f)?,
        None => ws.write_blank(r, 6, f)?,
    };
    ws.write_string_with_format(r, 7, &p.volume, f)?;
    ws.write_string_with_format(r, 8, &p.reference, f)?;
    ws.write_string_with_format(r, 9, &p.remarque, fw)?;
    ws.write_string_with_format(r, 10, &p.label, fw)?;
    let fiab = match (p.origine.as_str(), p.score) {
        ("fiche", _) => "fiche".to_string(),
        ("manuel", _) => "manuel".to_string(),
        (_, Some(s)) => format!("{:.0} %", s * 100.0),
        _ => String::new(),
    };
    ws.write_string_with_format(r, 11, fiab, f)?;
    if let Some((la, lo)) = p.position() {
        ws.write_number_with_format(r, 12, (la * 1e6).round() / 1e6, f)?;
        ws.write_number_with_format(r, 13, (lo * 1e6).round() / 1e6, f)?;
        ws.write_url_with_format(r, 15, Url::new(lien_point(la, lo)).set_text("Ouvrir"), f)?;
    }
    if let Some(k) = km {
        ws.write_number_with_format(r, 14, (k * 10.0).round() / 10.0, f)?;
    }
    ws.write_string_with_format(r, 16, &p.source, f)?;
    Ok(())
}
