use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::json;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::db::{album_display_path, image_abs_path, AppState, PooledConn};
use crate::error::{AppError, AppResult};
use crate::models::{
    AlbumNode, Bookmark, CreateBookmark, Filters, Page, PatchPhoto, PhotoDetail, PhotoSummary,
    SubAlbum, TagNode,
};
use crate::query::{self, Aspect, PhotoQuery, Rating, Sort, DEFAULT_LIMIT, MAX_LIMIT};

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
    /// Sort order (`modified` (default) / `created` / `name`).
    #[serde(default)]
    sort: Sort,
    limit: Option<u64>,
    offset: Option<u64>,
}

/// `GET /photos?album=/Root/path&tags=a,b&recursive&limit=&offset=`
pub async fn list_photos(
    State(state): State<AppState>,
    Query(params): Query<PhotoParams>,
) -> AppResult<Json<Page<PhotoSummary>>> {
    let q = PhotoQuery {
        album: query::album_segments(params.album.as_deref().unwrap_or_default()),
        filters: Filters {
            recursive: params.recursive,
            min_rating: params.min_rating,
            include_images: params.images,
            include_video: params.video,
            aspect: params.aspect,
            tags: parse_tags(params.tags.as_deref()),
            sort: params.sort,
        },
        limit: params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
        offset: params.offset.unwrap_or(0),
    };

    let page = run_blocking(&state, move |conn, state| {
        query::list_photos(conn, &state.roots, &q)
    })
    .await?;

    Ok(Json(page))
}

/// `GET /random?album=&tags=&recursive=&min_rating=&images=&video=&aspect=` —
/// **307-redirect** to a random matching item's `/api/photos/:id/file`. Handy for
/// screensavers / photo frames that just fetch a URL (each hit re-randomizes; pass
/// `video=false` for an images-only frame). Same album + filter params as
/// `/photos`. `404` when nothing matches.
pub async fn random_photo(
    State(state): State<AppState>,
    Query(params): Query<PhotoParams>,
) -> AppResult<Response> {
    let q = PhotoQuery {
        album: query::album_segments(params.album.as_deref().unwrap_or_default()),
        filters: Filters {
            recursive: params.recursive,
            min_rating: params.min_rating,
            include_images: params.images,
            include_video: params.video,
            aspect: params.aspect,
            tags: parse_tags(params.tags.as_deref()),
            sort: params.sort,
        },
        limit: 0,
        offset: 0,
    };

    let id = run_blocking(&state, move |conn, _state| query::random_photo_id(conn, &q))
        .await?
        .ok_or_else(|| AppError::NotFound("no item matches the given filters".into()))?;

    // `no-store` so a screensaver re-randomizes every hit (doesn't cache the redirect).
    Ok((
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Redirect::temporary(&format!("/api/photos/{id}/file")),
    )
        .into_response())
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
                    p.latitudeNumber, p.longitudeNumber, i.category, ii.creationDate, \
                    (SELECT group_concat(c.comment, char(10) ORDER BY c.type, c.language, c.id) \
                       FROM ImageComments c \
                       WHERE c.imageid = i.id AND c.comment IS NOT NULL AND trim(c.comment) <> '') \
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
                let name: String = row.get(1)?;
                let root = state.roots.get(&album_root);
                let album_path = root
                    .map(|r| album_display_path(r, &relative_path))
                    .unwrap_or_else(|| relative_path.clone());
                let file_path = root.map(|r| {
                    image_abs_path(r, &relative_path, &name)
                        .to_string_lossy()
                        .into_owned()
                });
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
                        creation_date: row.get(13)?,
                        mime,
                        is_video: row.get::<_, i64>(12)? == 2,
                    },
                    file_path,
                    description: row.get(14)?,
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

        // Each tag as its absolute path (e.g. `/vacation/2020/beach`): walk up the
        // `pid` chain prepending each ancestor's name to the top-level (pid 0).
        // Excludes Digikam's internal tags (Color/Pick labels, version history).
        let mut tag_stmt = conn.prepare_cached(
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
        let tags = tag_stmt
            .query_map([id, INTERNAL_TAG_ROOT], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(PhotoDetail { tags, ..row })
    })
    .await?;

    Ok(Json(detail))
}

/// `PATCH /photos/:id` — partial update of a photo's Digikam metadata. The only
/// field so far is `rating`: `{"rating": 3}` sets it, `{"rating": null}` clears
/// back to Digikam's "unrated" (-1), an absent field leaves it unchanged (so
/// `{}` is a valid no-op). Requires the server to have been started with
/// `--allow-writes` (else 403). Every change is logged with the image id, path,
/// and old/new value. Writes only the DB — not the file's XMP/EXIF metadata.
pub async fn patch_photo(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(patch): Json<PatchPhoto>,
) -> AppResult<StatusCode> {
    if !state.allow_writes {
        return Err(AppError::Forbidden(
            "writes are disabled; start the server with --allow-writes".into(),
        ));
    }
    let Some(rating) = patch.rating else {
        return Ok(StatusCode::NO_CONTENT);
    };

    run_blocking(&state, move |conn, state| {
        let (album_root, relative_path, name, old): (i64, String, String, Option<i64>) = conn
            .query_row(
                "SELECT a.albumRoot, a.relativePath, i.name, ii.rating FROM Images i \
                 JOIN Albums a ON a.id = i.album \
                 LEFT JOIN ImageInformation ii ON ii.imageid = i.id \
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

        let new = rating.map_or(-1, Rating::get);
        // Upsert: an image may have no ImageInformation row yet.
        conn.execute(
            "INSERT INTO ImageInformation (imageid, rating) VALUES (?1, ?2) \
             ON CONFLICT(imageid) DO UPDATE SET rating = excluded.rating",
            rusqlite::params![id, new],
        )?;

        // The path is best-effort, for the change log only: fall back to the
        // album-relative path when the root is unknown.
        let path = match state.roots.get(&album_root) {
            Some(root) => image_abs_path(root, &relative_path, &name)
                .to_string_lossy()
                .into_owned(),
            None => format!("root{album_root}:{relative_path}/{name}"),
        };
        tracing::info!(
            id,
            path = %path,
            old = %fmt_rating(old),
            new = %fmt_rating(Some(new)),
            "rating changed"
        );
        Ok(())
    })
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Render a stored rating for the change log: `-1` / no row = "unrated".
fn fmt_rating(r: Option<i64>) -> String {
    match r {
        Some(n) if n >= 0 => n.to_string(),
        _ => "unrated".into(),
    }
}

/// Query for `GET /photos/:id/reverse-search`.
#[derive(Debug, Deserialize)]
pub struct ReverseSearchParams {
    /// Search engine; only `yandex` is supported (the default).
    engine: Option<String>,
}

/// `GET /photos/:id/reverse-search?engine=yandex` — reverse-image-search the
/// original on Yandex, 302-redirecting to the results page.
///
/// The **server** does this, not the browser: this box is firewalled (so a `?url=`
/// search Yandex would have to fetch back is impossible — we must send the image
/// *bytes*), and Yandex's upload endpoint sends no CORS headers and returns only a
/// transitional "candidate" page, so the browser can't read the CBIR id to build
/// the results URL. Here we upload `upfile` to Yandex's JSON endpoint, read
/// `cbirId`, and redirect to the canonical `…&cbir_id=…` results page.
pub async fn reverse_search(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(params): Query<ReverseSearchParams>,
) -> AppResult<Response> {
    let engine = params.engine.as_deref().unwrap_or("yandex");
    if engine != "yandex" {
        return Err(AppError::BadRequest(format!(
            "unsupported engine: {engine}"
        )));
    }

    // Resolve the original's absolute path (as `get_photo_file` does).
    let (path, name) = run_blocking(&state, move |conn, state| {
        let (album_root, relative_path, name): (i64, String, String) = conn
            .query_row(
                "SELECT a.albumRoot, a.relativePath, i.name FROM Images i \
                 JOIN Albums a ON a.id = i.album \
                 WHERE i.id = ?1 AND i.status = 1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
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
        Ok((image_abs_path(root, &relative_path, &name), name))
    })
    .await?;

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("reading {}: {e}", path.display())))?;
    let mime = mime_guess::from_path(&name)
        .first_or_octet_stream()
        .essence_str()
        .to_string();

    let url = yandex_reverse_search_url(bytes, name, mime).await?;
    Ok(Redirect::to(&url).into_response())
}

/// Upload image bytes to Yandex's reverse-image-search and return the canonical
/// results-page URL (built from the `cbirId` in its JSON response).
async fn yandex_reverse_search_url(
    bytes: Vec<u8>,
    name: String,
    mime: String,
) -> AppResult<String> {
    let bad_gateway = |e: String| AppError::BadGateway(format!("Yandex reverse search: {e}"));

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(name)
        .mime_str(&mime)
        .map_err(|e| bad_gateway(e.to_string()))?;
    let form = reqwest::multipart::Form::new().part("upfile", part);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        // A browser-like UA; Yandex serves bot-ish clients a captcha page.
        .user_agent("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0")
        .build()
        .map_err(|e| bad_gateway(e.to_string()))?;

    let resp = client
        .post("https://yandex.com/images/search")
        .query(&[
            ("rpt", "imageview"),
            ("format", "json"),
            (
                "request",
                r#"{"blocks":[{"block":"b-page_type_search-by-image__link"}]}"#,
            ),
        ])
        .multipart(form)
        .send()
        .await
        .map_err(|e| bad_gateway(e.to_string()))?
        .error_for_status()
        .map_err(|e| bad_gateway(e.to_string()))?;

    let json: serde_json::Value = resp.json().await.map_err(|e| bad_gateway(e.to_string()))?;
    let cbir_id = json["blocks"][0]["params"]["cbirId"]
        .as_str()
        .ok_or_else(|| bad_gateway("no cbirId in response".into()))?;

    Ok(format!(
        "https://yandex.com/images/search?rpt=imageview&cbir_id={}&cbir_page=similar",
        urlencoding::encode(cbir_id)
    ))
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
    /// Sort order (`modified` (default) / `created` / `name`); `name` lists the
    /// sub-albums alphabetically, `created` derives covers/recency from creationDate.
    #[serde(default)]
    sort: Sort,
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
        // `recursive` is irrelevant here — sub-album counts/covers are always
        // computed over the whole subtree (`list_subalbums` ignores it).
        recursive: false,
        min_rating: params.min_rating,
        include_images: params.images,
        include_video: params.video,
        aspect: params.aspect,
        tags: parse_tags(params.tags.as_deref()),
        sort: params.sort,
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
        filters: Filters {
            recursive: row.get::<_, i64>(2)? != 0,
            min_rating: Rating::new(row.get::<_, i64>(3)?).unwrap_or_default(),
            include_images: row.get::<_, i64>(4)? != 0,
            include_video: row.get::<_, i64>(5)? != 0,
            aspect: Aspect::parse(&row.get::<_, String>(6)?).unwrap_or_default(),
            // tags stored as a JSON array; tolerate anything unexpected as empty.
            tags: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
            sort: Sort::parse(&row.get::<_, String>(8)?).unwrap_or_default(),
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
                b.filters.aspect.as_str(),
                tags_json,
                b.filters.sort.as_str(),
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
