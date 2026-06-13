use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::json;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::db::{album_display_path, image_abs_path, AppState, PooledConn};
use crate::error::{AppError, AppResult};
use crate::models::{
    AlbumNode, Bookmark, CreateBookmark, Filters, Page, PhotoDetail, PhotoMetadata, PhotoSummary,
    SubAlbum, TagNode,
};
use crate::query::{self, Aspect, PhotoQuery, Rating, DEFAULT_LIMIT, MAX_LIMIT};

/// Digikam's internal tag root (`_Digikam_Internal_Tags_`). Its subtree holds the
/// Color-Label / Pick-Label / version-history tags — internal bookkeeping, not real
/// user tags — so it's excluded from `/api/tags` and from per-image tag listings.
/// (Descendants are `SELECT id FROM TagsTree WHERE pid = INTERNAL_TAG_ROOT`.)
const INTERNAL_TAG_ROOT: i64 = 1;

/// `GET /health`
pub async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

/// Serde default for the media-type booleans: both media types included.
fn yes() -> bool {
    true
}

/// Parse a comma-separated `tags=` param into filter tokens (trimmed, no empties).
fn parse_tags(s: Option<&str>) -> Vec<String> {
    s.map(|s| {
        s.split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

/// Raw query parameters for `GET /photos`.
#[derive(Debug, Deserialize)]
pub struct PhotoParams {
    album: Option<String>,
    tags: Option<String>,
    #[serde(default)]
    recursive: bool,
    #[serde(default)]
    min_rating: Rating,
    /// Media-type filter (both default on; `=false` excludes that type).
    #[serde(default = "yes")]
    images: bool,
    #[serde(default = "yes")]
    video: bool,
    /// Aspect-ratio filter (`all` (default) / `portrait` / `landscape`).
    #[serde(default)]
    aspect: Aspect,
    limit: Option<u64>,
    offset: Option<u64>,
}

/// `GET /photos?album=/Root/path&tags=a,b&recursive&limit=&offset=`
pub async fn list_photos(
    State(state): State<AppState>,
    Query(params): Query<PhotoParams>,
) -> AppResult<Json<Page<PhotoSummary>>> {
    let tags = parse_tags(params.tags.as_deref());

    let q = PhotoQuery {
        album: query::album_segments(params.album.as_deref().unwrap_or_default()),
        recursive: params.recursive,
        tags,
        min_rating: params.min_rating,
        include_images: params.images,
        include_video: params.video,
        aspect: params.aspect,
        limit: params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
        offset: params.offset.unwrap_or(0),
    };

    let page = run_blocking(&state, move |conn, state| {
        query::list_photos(conn, &state.roots, &q)
    })
    .await?;

    Ok(Json(page))
}

/// `GET /photos/:id`
pub async fn get_photo(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<PhotoDetail>> {
    let detail = run_blocking(&state, move |conn, state| {
        let mut stmt = conn.prepare(
            "SELECT i.id, i.name, a.albumRoot, a.relativePath, i.fileSize, \
                    ii.format, ii.width, ii.height, ii.rating, i.modificationDate, \
                    p.latitudeNumber, p.longitudeNumber, i.category \
             FROM Images i \
             JOIN Albums a ON a.id = i.album \
             JOIN AlbumRoots r ON r.id = a.albumRoot \
             LEFT JOIN ImageInformation ii ON ii.imageid = i.id \
             LEFT JOIN ImagePositions p ON p.imageid = i.id \
             WHERE i.id = ?1 AND i.status = 1",
        )?;

        let row = stmt
            .query_row([id], |row| {
                let album_root: i64 = row.get(2)?;
                let relative_path: String = row.get(3)?;
                let album_path = state
                    .roots
                    .get(&album_root)
                    .map(|r| album_display_path(r, &relative_path))
                    .unwrap_or_else(|| relative_path.clone());
                let name: String = row.get(1)?;
                let mime = mime_guess::from_path(&name)
                    .first()
                    .map(|m| m.essence_str().to_string());
                Ok(PhotoDetail {
                    summary: PhotoSummary {
                        id: row.get::<_, i64>(0)? as u64,
                        name,
                        album_path,
                        file_size: opt_u64(row.get(4)?),
                        format: row.get(5)?,
                        width: opt_u64(row.get(6)?),
                        height: opt_u64(row.get(7)?),
                        rating: opt_u64(row.get(8)?),
                        modification_date: row.get(9)?,
                        mime,
                        is_video: row.get::<_, i64>(12)? == 2,
                    },
                    tags: Vec::new(),
                    latitude: row.get(10)?,
                    longitude: row.get(11)?,
                })
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound(format!("photo {id} not found"))
                }
                other => AppError::from(other),
            })?;

        // Attach tag names, excluding Digikam's internal tags (Color/Pick labels …).
        let mut tag_stmt = conn.prepare_cached(
            "SELECT t.name FROM ImageTags it JOIN Tags t ON t.id = it.tagid \
             WHERE it.imageid = ?1 AND it.tagid NOT IN (SELECT id FROM TagsTree WHERE pid = ?2) \
             ORDER BY t.name",
        )?;
        let tags = tag_stmt
            .query_map([id, INTERNAL_TAG_ROOT], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(PhotoDetail { tags, ..row })
    })
    .await?;

    Ok(Json(detail))
}

/// `GET /photos/:id/metadata` — extended per-image metadata (creation date, GPS,
/// tags), fetched lazily by the lightbox info panel.
pub async fn get_photo_metadata(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<PhotoMetadata>> {
    let (creation_date, latitude, longitude, tags) = run_blocking(&state, move |conn, _state| {
        // Creation date (import/EXIF time) + GPS, each NULL/absent -> None.
        let (creation_date, latitude, longitude) = conn
            .query_row(
                "SELECT ii.creationDate, p.latitudeNumber, p.longitudeNumber FROM Images i \
                 LEFT JOIN ImageInformation ii ON ii.imageid = i.id \
                 LEFT JOIN ImagePositions p ON p.imageid = i.id \
                 WHERE i.id = ?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<f64>>(1)?,
                        r.get::<_, Option<f64>>(2)?,
                    ))
                },
            )
            .optional()?
            .unwrap_or((None, None, None));

        // Each tag as its absolute path (e.g. `/local/blender/todo`): start from the
        // image's tags, then walk up the `pid` chain prepending each ancestor's name
        // until the top-level (pid 0). Excludes Digikam's internal tags (Color/Pick
        // labels, version history) by dropping any tag under INTERNAL_TAG_ROOT.
        let mut stmt = conn.prepare_cached(
            "WITH RECURSIVE paths(pid, path) AS ( \
               SELECT t.pid, t.name \
               FROM ImageTags it JOIN Tags t ON t.id = it.tagid \
               WHERE it.imageid = ?1 \
                 AND it.tagid NOT IN (SELECT id FROM TagsTree WHERE pid = ?2) \
               UNION ALL \
               SELECT par.pid, par.name || '/' || p.path \
               FROM paths p JOIN Tags par ON par.id = p.pid \
               WHERE p.pid <> 0 \
             ) \
             SELECT '/' || path FROM paths WHERE pid = 0 ORDER BY path COLLATE NOCASE",
        )?;
        let tags = stmt
            .query_map([id, INTERNAL_TAG_ROOT], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok((creation_date, latitude, longitude, tags))
    })
    .await?;

    Ok(Json(PhotoMetadata {
        creation_date,
        latitude,
        longitude,
        tags,
    }))
}

/// `GET /photos/:id/file` — serve the original image bytes (range-aware).
///
/// Sets a strong `ETag` derived from the image's `uniqueHash` (which Digikam
/// recomputes when a file's content changes), so clients and caches can
/// revalidate cheaply. A matching `If-None-Match` short-circuits with `304`.
pub async fn get_photo_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    request: Request<axum::body::Body>,
) -> AppResult<Response> {
    let (path, etag, name) = run_blocking(&state, move |conn, state| {
        let (album_root, relative_path, name, unique_hash): (i64, String, String, Option<String>) =
            conn.query_row(
                "SELECT a.albumRoot, a.relativePath, i.name, i.uniqueHash FROM Images i \
                 JOIN Albums a ON a.id = i.album \
                 WHERE i.id = ?1 AND i.status = 1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound(format!("photo {id} not found"))
                }
                other => AppError::from(other),
            })?;

        let root = state
            .roots
            .get(&album_root)
            .ok_or_else(|| AppError::NotFound(format!("album root {album_root} unknown")))?;

        // Build a strong ETag from the content hash; skip if Digikam has none.
        let etag = unique_hash
            .filter(|h| !h.is_empty())
            .and_then(|h| HeaderValue::from_str(&format!("\"{h}\"")).ok());

        Ok((image_abs_path(root, &relative_path, &name), etag, name))
    })
    .await?;

    // If the client already holds this exact content, don't re-send it.
    if let Some(etag) = &etag {
        if if_none_match_matches(request.headers(), etag) {
            let mut not_modified = Response::new(axum::body::Body::empty());
            *not_modified.status_mut() = StatusCode::NOT_MODIFIED;
            not_modified
                .headers_mut()
                .insert(header::ETAG, etag.clone());
            return Ok(not_modified);
        }
    }

    let mut response = ServeFile::new(&path)
        .oneshot(request)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("file service error: {e}")))?
        .map(axum::body::Body::new);

    if let Some(etag) = etag {
        response.headers_mut().insert(header::ETAG, etag);
    }
    // Suggest the original filename when the image is saved (kept `inline`, so the
    // browser still displays it — the grid/lightbox load this same URL as an image).
    if let Some(cd) = content_disposition(&name) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, cd);
    }

    Ok(response)
}

/// A `Content-Disposition: inline` value carrying the original file name, with an
/// ASCII fallback plus an RFC 5987 `filename*` for non-ASCII names.
fn content_disposition(name: &str) -> Option<HeaderValue> {
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() && c != '"' && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded = urlencoding::encode(name);
    HeaderValue::from_str(&format!(
        "inline; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"
    ))
    .ok()
}

/// `Cache-Control` for content-addressed, effectively-immutable assets (the PGF
/// thumbnails — keyed by `uniqueHash` — and the embedded webpgf module): cache
/// hard for a year and don't revalidate, so the browser stops re-requesting them
/// on every page load. The strong `ETag` still backs a forced reload / expired
/// entry with a cheap `304`. (A re-edited image keeps its id but gets a new
/// `uniqueHash`/ETag; an `immutable` cache won't notice until a hard refresh.)
pub(crate) const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// Does the request's `If-None-Match` header match `etag` (or `*`)?
pub(crate) fn if_none_match_matches(headers: &HeaderMap, etag: &HeaderValue) -> bool {
    let Some(value) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let want = strip_weak(etag.to_str().unwrap_or_default());
    value
        .split(',')
        .map(str::trim)
        .any(|candidate| candidate == "*" || strip_weak(candidate) == want)
}

/// Strip a weak-validator `W/` prefix for comparison purposes.
fn strip_weak(tag: &str) -> &str {
    tag.strip_prefix("W/").unwrap_or(tag)
}

/// `GET /photos/:id/thumbnail` — serve Digikam's stored thumbnail **as-is**: the
/// raw PGF blob from `thumbnails-digikam.db`, looked up by the image's
/// `uniqueHash` + `fileSize`. The client decodes the PGF (wasm). Sends a strong
/// `ETag` (content hash) honoring `If-None-Match`, and an `X-Orientation` header
/// with Digikam's `orientationHint` (EXIF orientation) for client-side rotation.
///
/// `404` when the thumbnails DB is absent, the image is unknown, or it has no
/// cached thumbnail — the client then falls back to `/file`.
pub async fn get_photo_thumbnail(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let (hash, data, orientation) = run_blocking(&state, move |conn, state| {
        // The image's content key (uniqueHash + fileSize) from the main DB.
        let row: Option<(Option<String>, Option<i64>)> = conn
            .query_row(
                "SELECT uniqueHash, fileSize FROM Images WHERE id = ?1 AND status = 1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (hash, size) = match row {
            Some((Some(hash), Some(size))) => (hash, size),
            _ => return Err(AppError::NotFound(format!("photo {id} not found"))),
        };

        let Some(thumbs) = state.thumbs.as_ref() else {
            return Err(AppError::NotFound(
                "thumbnails database not available".into(),
            ));
        };
        let tconn = thumbs.get()?;
        let thumb: Option<(Vec<u8>, Option<i64>)> = tconn
            .query_row(
                "SELECT t.data, t.orientationHint FROM UniqueHashes u \
                 JOIN Thumbnails t ON t.id = u.thumbId \
                 WHERE u.uniqueHash = ?1 AND u.fileSize = ?2",
                rusqlite::params![hash, size],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match thumb {
            Some((data, orientation)) => Ok((hash, data, orientation)),
            None => Err(AppError::NotFound(format!("no thumbnail for photo {id}"))),
        }
    })
    .await?;

    // Content-based ETag (distinct from the /file ETag via the suffix).
    let etag = HeaderValue::from_str(&format!("\"{hash}-thumb\"")).ok();
    if let Some(etag) = &etag {
        if if_none_match_matches(&headers, etag) {
            let mut not_modified = Response::new(axum::body::Body::empty());
            *not_modified.status_mut() = StatusCode::NOT_MODIFIED;
            let h = not_modified.headers_mut();
            h.insert(header::ETAG, etag.clone());
            h.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(IMMUTABLE_CACHE_CONTROL),
            );
            return Ok(not_modified);
        }
    }

    let mut response = Response::new(axum::body::Body::from(data));
    let h = response.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(IMMUTABLE_CACHE_CONTROL),
    );
    if let Some(etag) = etag {
        h.insert(header::ETAG, etag);
    }
    if let Some(orientation) = orientation {
        if let Ok(v) = HeaderValue::from_str(&orientation.to_string()) {
            h.insert("x-orientation", v);
        }
    }
    Ok(response)
}

/// Query parameters for `GET /subalbums`.
#[derive(Debug, Deserialize)]
pub struct SubalbumParams {
    album: Option<String>,
    #[serde(default)]
    min_rating: Rating,
    /// Media-type filter (both default on; `=false` excludes that type),
    /// constraining the sub-album counts/covers like `min_rating`.
    #[serde(default = "yes")]
    images: bool,
    #[serde(default = "yes")]
    video: bool,
    /// Aspect-ratio filter (`all` (default) / `portrait` / `landscape`).
    #[serde(default)]
    aspect: Aspect,
    /// Comma-separated tag filter (same hierarchical semantics as `/photos`).
    tags: Option<String>,
}

/// `GET /subalbums?album=/Root/rel&min_rating=&images=&video=` — direct sub-albums
/// of an album, each with a cover (newest photo in its subtree) and recursive photo
/// count, sorted by most recent photo. `min_rating` and the `images`/`video`
/// media-type filter constrain the cover and count alike. An absent/empty `album`
/// lists the album roots.
pub async fn list_subalbums(
    State(state): State<AppState>,
    Query(params): Query<SubalbumParams>,
) -> AppResult<Json<Vec<SubAlbum>>> {
    let album = query::album_segments(params.album.as_deref().unwrap_or_default());

    let filters = Filters {
        min_rating: params.min_rating,
        include_images: params.images,
        include_video: params.video,
        aspect: params.aspect,
        tags: parse_tags(params.tags.as_deref()),
    };

    let subalbums = run_blocking(&state, move |conn, state| {
        query::list_subalbums(conn, &state.roots, &album, &filters)
    })
    .await?;

    Ok(Json(subalbums))
}

/// `GET /albums`
pub async fn list_albums(State(state): State<AppState>) -> AppResult<Json<Vec<AlbumNode>>> {
    let albums = run_blocking(&state, |conn, state| {
        let mut stmt = conn.prepare(
            "SELECT id, albumRoot, relativePath FROM Albums ORDER BY albumRoot, relativePath",
        )?;
        let albums = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|(id, album_root, relative_path)| {
                let root = state.roots.get(&album_root)?;
                Some(AlbumNode {
                    id: id as u64,
                    path: album_display_path(root, &relative_path),
                    root: root.label.clone(),
                })
            })
            .collect::<Vec<_>>();
        Ok(albums)
    })
    .await?;

    Ok(Json(albums))
}

/// `GET /tags` — the tag hierarchy as a tree, excluding Digikam's internal tags.
pub async fn list_tags(State(state): State<AppState>) -> AppResult<Json<Vec<TagNode>>> {
    let tree = run_blocking(&state, |conn, _state| {
        let mut stmt = conn.prepare("SELECT id, pid, name FROM Tags ORDER BY name")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut children: HashMap<i64, Vec<(i64, String)>> = HashMap::new();
        for (id, pid, name) in rows {
            children.entry(pid).or_default().push((id, name));
        }

        fn build(id: i64, name: String, children: &HashMap<i64, Vec<(i64, String)>>) -> TagNode {
            let kids = children
                .get(&id)
                .map(|cs| {
                    cs.iter()
                        .map(|(cid, cname)| build(*cid, cname.clone(), children))
                        .collect()
                })
                .unwrap_or_default();
            TagNode {
                id: id as u64,
                name,
                children: kids,
            }
        }

        let tree = children
            .get(&0)
            .map(|tops| {
                tops.iter()
                    .filter(|(id, _)| *id != INTERNAL_TAG_ROOT)
                    .map(|(id, name)| build(*id, name.clone(), &children))
                    .collect()
            })
            .unwrap_or_default();
        Ok(tree)
    })
    .await?;

    Ok(Json(tree))
}

/// Map a non-negative integer column to `Option<u64>`, treating negatives as absent.
fn opt_u64(v: Option<i64>) -> Option<u64> {
    v.and_then(|n| u64::try_from(n).ok())
}

/// Run a blocking database closure on the blocking thread pool.
pub(crate) async fn run_blocking<F, T>(state: &AppState, f: F) -> AppResult<T>
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
        recursive: row.get::<_, i64>(2)? != 0,
        filters: Filters {
            min_rating: Rating::new(row.get::<_, i64>(3)?).unwrap_or_default(),
            include_images: row.get::<_, i64>(4)? != 0,
            include_video: row.get::<_, i64>(5)? != 0,
            aspect: Aspect::parse(&row.get::<_, String>(6)?).unwrap_or_default(),
            // tags stored as a JSON array; tolerate anything unexpected as empty.
            tags: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
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
            "SELECT name, album, recursive, min_rating, images, video, aspect, tags \
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
        recursive: req.recursive,
        filters: req.filters,
    };
    let overwrite = req.overwrite;
    let b = bookmark.clone();

    run_web(&state, move |conn| {
        let sql = if overwrite {
            "INSERT OR REPLACE INTO bookmarks \
               (name, album, recursive, min_rating, images, video, aspect, tags) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        } else {
            "INSERT INTO bookmarks \
               (name, album, recursive, min_rating, images, video, aspect, tags) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        };
        let tags_json = serde_json::to_string(&b.filters.tags).unwrap_or_else(|_| "[]".into());
        conn.execute(
            sql,
            rusqlite::params![
                b.name,
                b.album,
                b.recursive as i64,
                b.filters.min_rating.get(),
                b.filters.include_images as i64,
                b.filters.include_video as i64,
                b.filters.aspect.as_str(),
                tags_json,
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
