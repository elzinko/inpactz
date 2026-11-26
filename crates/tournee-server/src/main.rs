//! Service web de tournée PAV : sert l'interface et expose le moteur `tournee-core` en API.

use axum::{
    extract::{DefaultBodyLimit, Multipart},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tournee_core::{extract, geocode::Geocodeur, solve, xlsx, Depot, Point, Tournee};

const INDEX: &str = include_str!("../static/index.html");
const MANIFEST: &str = include_str!("../static/manifest.webmanifest");
const ICONE: &str = include_str!("../static/icone.svg");

type Erreur = (StatusCode, Json<serde_json::Value>);
fn erreur(code: StatusCode, msg: impl ToString) -> Erreur {
    (code, Json(serde_json::json!({ "erreur": msg.to_string() })))
}

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let app = Router::new()
        .route("/", get(|| async { Html(INDEX) }))
        .route("/manifest.webmanifest", get(|| async { ([(header::CONTENT_TYPE, "application/manifest+json")], MANIFEST) }))
        .route("/icone.svg", get(|| async { ([(header::CONTENT_TYPE, "image/svg+xml")], ICONE) }))
        .route("/api/sante", get(|| async { "ok" }))
        .route("/api/lire", post(lire))
        .route("/api/placer", post(placer))
        .route("/api/tournee", post(tournee))
        .route("/api/recalculer", post(recalculer))
        .route("/api/excel", post(excel))
        .layer(DefaultBodyLimit::max(60 * 1024 * 1024));
    let addr = format!("0.0.0.0:{port}");
    println!("Tournée PAV sur http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("port");
    axum::serve(listener, app).await.unwrap();
}

/// Reçoit les fiches (multipart) et renvoie ce qui a été lu dans chacune.
async fn lire(mut mp: Multipart) -> Result<Json<Vec<extract::Lecture>>, Erreur> {
    let mut lectures = vec![];
    while let Some(champ) = mp.next_field().await.map_err(|e| erreur(StatusCode::BAD_REQUEST, e))? {
        let nom = champ.file_name().unwrap_or("fiche").to_string();
        let octets = champ.bytes().await.map_err(|e| erreur(StatusCode::BAD_REQUEST, e))?;
        lectures.push(extract::lire_fichier(&nom, &octets).await);
    }
    Ok(Json(lectures))
}

#[derive(Deserialize)]
struct Demande {
    depot: Depot,
    #[serde(default)]
    points: Vec<Point>,
    #[serde(default)]
    date: String,
}

#[derive(Serialize)]
struct Places {
    depot: Depot,
    points: Vec<Point>,
    places: usize,
    erreur: Option<String>,
}

/// Géocode le dépôt et les points sans position (Base Adresse Nationale).
async fn placer(Json(mut d): Json<Demande>) -> Json<Places> {
    d.points = tournee_core::fusionner_doublons(d.points);
    let g = Geocodeur::new();
    let mut err = None;
    if !d.depot.adresse.trim().is_empty() {
        if let Err(e) = g.placer_depot(&mut d.depot).await {
            err = Some(e);
        }
    }
    let mut n = 0;
    if err.is_none() {
        match g.placer_points(&mut d.points, d.depot.position()).await {
            Ok(k) => n = k,
            Err(e) => err = Some(e),
        }
    }
    Json(Places { depot: d.depot, points: d.points, places: n, erreur: err })
}

#[derive(Serialize)]
struct Reponse {
    #[serde(flatten)]
    tournee: Tournee,
    liens: Vec<(String, String)>,
}

async fn tournee(Json(d): Json<Demande>) -> Result<Json<Reponse>, Erreur> {
    let date = d.date.clone();
    let t = tokio::task::spawn_blocking(move || solve::calculer(&d.depot, &d.points, 500))
        .await
        .map_err(|e| erreur(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(|e| erreur(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let mut t = t;
    t.date = date;
    Ok(Json(Reponse { liens: xlsx::liens_itineraire(&t), tournee: t }))
}

#[derive(Deserialize)]
struct Ordre {
    depot: Depot,
    arrets: Vec<Point>,
    #[serde(default)]
    non_places: Vec<Point>,
    #[serde(default)]
    date: String,
}

async fn recalculer(Json(o): Json<Ordre>) -> Result<Json<Reponse>, Erreur> {
    let mut t = solve::recalculer(&o.depot, o.arrets).map_err(|e| erreur(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    t.non_places = o.non_places;
    t.date = o.date;
    Ok(Json(Reponse { liens: xlsx::liens_itineraire(&t), tournee: t }))
}

async fn excel(Json(t): Json<Tournee>) -> Result<Response, Erreur> {
    let octets = xlsx::generer(&t).map_err(|e| erreur(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let nom = format!("tournee-pav-{}.xlsx", if t.date.is_empty() { "export".into() } else { t.date.clone() });
    Ok((
        [
            (header::CONTENT_TYPE, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{nom}\"")),
        ],
        octets,
    )
        .into_response())
}
