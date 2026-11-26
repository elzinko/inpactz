//! Moteur de tournée PAV.
//!
//! - [`extract`] : lit le texte des fiches (PDF texte, OCR Tesseract pour photos et scans)
//!   et en tire des points de collecte, sans IA.
//! - [`geocode`] : adresse → GPS avec la Base Adresse Nationale (sans clé).
//! - [`solve`] : ordre de passage avec le solveur open source `vrp-pragmatic`.
//! - [`xlsx`] : feuille de route Excel.
//!
//! Tout est indépendant de l'interface : la même bibliothèque sert au service web
//! et servira à l'application mobile.

pub mod extract;
#[cfg(feature = "natif")]
pub mod geocode;
pub mod model;
pub mod solve;
pub mod tableur;
pub mod xlsx;

/// Score BAN au-dessus duquel une position est jugée fiable.
pub const SCORE_FIABLE: f64 = 0.6;

pub use model::*;
