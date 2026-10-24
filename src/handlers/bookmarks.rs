//! Bookmarks: named album + filter snapshots, stored in our own `web.sql`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;

use crate::db::{AppState, PooledConn};
use crate::error::{AppError, AppResult};
use crate::models::{Bookmark, CreateBookmark, Filters};
use crate::query::{self, Rating};

/// Like [`run_blocking`], but against the writable bookmarks pool (`web.sql`).
/// Errors if that DB couldn't be opened.
async fn run_web<F, T>(state: &AppState, f: F) -> AppResult<T>
where
    F: FnOnce(&PooledConn) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    let pool = state
        .web
        .clone()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("bookmarks database unavailable")))?;
    tokio::task::spawn_blocking(move || {
        let conn = pool.get()?;
        f(&conn)
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("task join error: {e}")))?
}

/// Map a row of the `bookmarks` table to a [`Bookmark`].
fn row_to_bookmark(row: &rusqlite::Row) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark {
        name: row.get(0)?,
        album: row.get(1)?,
        filters: Filters {
            recursive: row.get::<_, i64>(2)? != 0,
            min_rating: Rating::new(row.get::<_, i64>(3)?).unwrap_or_default(),
            include_images: row.get::<_, i64>(4)? != 0,
            include_video: row.get::<_, i64>(5)? != 0,
            aspect: query::parse_variant(&row.get::<_, String>(6)?).unwrap_or_default(),
            // tags stored as a JSON array; tolerate anything unexpected as empty.
            tags: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
            sort: query::parse_variant(&row.get::<_, String>(8)?).unwrap_or_default(),
        },
    })
}

/// `GET /bookmarks` — all saved bookmarks, sorted by name (case-insensitive).
/// Returns `[]` when the bookmarks DB is unavailable.
pub async fn list_bookmarks(State(state): State<AppState>) -> AppResult<Json<Vec<Bookmark>>> {
    if state.web.is_none() {
        return Ok(Json(Vec::new()));
    }
    let bookmarks = run_web(&state, |conn| {
        let mut stmt = conn.prepare(
            "SELECT name, album, recursive, min_rating, images, video, aspect, tags, sort \
             FROM bookmarks ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt
            .query_map([], row_to_bookmark)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .await?;
    Ok(Json(bookmarks))
}

/// `POST /bookmarks` — create a bookmark, or overwrite a same-named one when
/// `overwrite` is set. A duplicate name without `overwrite` is a `409`.
pub async fn create_bookmark(
    State(state): State<AppState>,
    Json(req): Json<CreateBookmark>,
) -> AppResult<Json<Bookmark>> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest(
            "bookmark name must not be empty".into(),
        ));
    }
    if name.chars().count() > 100 {
        return Err(AppError::BadRequest("bookmark name is too long".into()));
    }

    let bookmark = Bookmark {
        name,
        album: req.album,
        filters: req.filters,
    };
    let overwrite = req.overwrite;
    let b = bookmark.clone();

    run_web(&state, move |conn| {
        let sql = if overwrite {
            "INSERT OR REPLACE INTO bookmarks \
               (name, album, recursive, min_rating, images, video, aspect, tags, sort) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        } else {
            "INSERT INTO bookmarks \
               (name, album, recursive, min_rating, images, video, aspect, tags, sort) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        };
        let tags_json = serde_json::to_string(&b.filters.tags).unwrap_or_else(|_| "[]".into());
        conn.execute(
            sql,
            rusqlite::params![
                b.name,
                b.album,
                b.filters.recursive as i64,
                b.filters.min_rating.get(),
                b.filters.include_images as i64,
                b.filters.include_video as i64,
                query::variant_name(&b.filters.aspect),
                tags_json,
                query::variant_name(&b.filters.sort),
            ],
        )
        .map_err(|e| match &e {
            rusqlite::Error::SqliteFailure(f, _)
                if f.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                AppError::Conflict(format!("a bookmark named \"{}\" already exists", b.name))
            }
            _ => AppError::from(e),
        })?;
        Ok(())
    })
    .await?;

    Ok(Json(bookmark))
}

/// `DELETE /bookmarks/:name` — remove a bookmark (idempotent).
pub async fn delete_bookmark(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> AppResult<StatusCode> {
    run_web(&state, move |conn| {
        conn.execute("DELETE FROM bookmarks WHERE name = ?1", [name])?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
