//! The HTTP handlers, split by area: listing/browsing ([`browse`]), photo detail
//! ([`detail`]), the write endpoint ([`write`](mod@write)), original/thumbnail/reverse-search
//! serving ([`media`]), and bookmarks ([`bookmarks`]). This module holds the
//! plumbing they share.

use std::collections::HashMap;
use std::path::PathBuf;

use axum::response::IntoResponse;
use axum::Json;
use rusqlite::OptionalExtension;
use serde_json::json;

use crate::db::{image_abs_path, AlbumRoot, AppState, PooledConn};
use crate::error::{AppError, AppResult};

pub mod bookmarks;
pub mod browse;
pub mod detail;
pub mod media;
pub mod write;

/// Digikam's internal tag root (`_Digikam_Internal_Tags_`). Its subtree holds the
/// Color-Label / Pick-Label / version-history tags — internal bookkeeping, not real
/// user tags — so it's excluded from `/api/tags` and from per-image tag listings.
/// (Descendants are `SELECT id FROM TagsTree WHERE pid = INTERNAL_TAG_ROOT`.)
const INTERNAL_TAG_ROOT: i64 = 1;

/// `GET /health`
pub async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

/// A visible photo's `Images` row plus its album location — the columns the
/// per-photo handlers (file, thumbnail, reverse search, PATCH) share.
struct ImageRow {
    /// `Images.album`, the album id.
    album: i64,
    album_root: i64,
    /// The album's `relativePath` (`"/"` for a root album).
    relative_path: String,
    name: String,
    file_size: Option<i64>,
    unique_hash: Option<String>,
}

impl ImageRow {
    /// Absolute path of the original on disk; a 404 if its album root is
    /// unknown (e.g. skipped at startup for an unparseable identifier).
    fn abs_path(&self, roots: &HashMap<i64, AlbumRoot>) -> AppResult<PathBuf> {
        let root = roots
            .get(&self.album_root)
            .ok_or_else(|| AppError::NotFound(format!("album root {} unknown", self.album_root)))?;
        Ok(image_abs_path(root, &self.relative_path, &self.name))
    }
}

/// Load a visible (`status = 1`) photo's [`ImageRow`]; a 404 for an unknown,
/// trashed, or obsolete id.
fn load_image(conn: &PooledConn, id: i64) -> AppResult<ImageRow> {
    conn.prepare_cached(
        "SELECT i.album, a.albumRoot, a.relativePath, i.name, i.fileSize, i.uniqueHash \
         FROM Images i JOIN Albums a ON a.id = i.album \
         WHERE i.id = ?1 AND i.status = 1",
    )?
    .query_row([id], |row| {
        Ok(ImageRow {
            album: row.get(0)?,
            album_root: row.get(1)?,
            relative_path: row.get(2)?,
            name: row.get(3)?,
            file_size: row.get(4)?,
            unique_hash: row.get(5)?,
        })
    })
    .optional()?
    .ok_or_else(|| photo_not_found(id))
}

/// The 404 for a photo id that doesn't exist or isn't visible.
fn photo_not_found(id: i64) -> AppError {
    AppError::NotFound(format!("photo {id} not found"))
}

/// Run a blocking database closure on the blocking thread pool.
async fn run_blocking<F, T>(state: &AppState, f: F) -> AppResult<T>
where
    F: FnOnce(&PooledConn, &AppState) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        let conn = state.pool.get()?;
        f(&conn, &state)
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("task join error: {e}")))?
}
