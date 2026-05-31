use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::db::{album_display_path, image_abs_path, AppState, PooledConn};
use crate::error::{AppError, AppResult};
use crate::models::{AlbumNode, Page, PhotoDetail, PhotoSummary, SubAlbum, TagNode};
use crate::query::{self, Filters, PhotoQuery, Rating, DEFAULT_LIMIT, MAX_LIMIT};

/// `GET /health`
pub async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
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
    limit: Option<u64>,
    offset: Option<u64>,
}

/// `GET /photos?album=/Root/path&tags=a,b&recursive&limit=&offset=`
pub async fn list_photos(
    State(state): State<AppState>,
    Query(params): Query<PhotoParams>,
) -> AppResult<Json<Page<PhotoSummary>>> {
    let tags = params
        .tags
        .as_deref()
        .map(|s| {
            s.split(',')
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let q = PhotoQuery {
        album: query::album_segments(params.album.as_deref().unwrap_or_default()),
        recursive: params.recursive,
        tags,
        min_rating: params.min_rating,
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
                    ii.format, ii.width, ii.height, ii.rating, ii.creationDate, \
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
                        creation_date: row.get(9)?,
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

        // Attach tag names.
        let mut tag_stmt = conn.prepare_cached(
            "SELECT t.name FROM ImageTags it JOIN Tags t ON t.id = it.tagid \
             WHERE it.imageid = ?1 ORDER BY t.name",
        )?;
        let tags = tag_stmt
            .query_map([id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(PhotoDetail { tags, ..row })
    })
    .await?;

    Ok(Json(detail))
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
    let (path, etag) = run_blocking(&state, move |conn, state| {
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

        Ok((image_abs_path(root, &relative_path, &name), etag))
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

    Ok(response)
}

/// Does the request's `If-None-Match` header match `etag` (or `*`)?
fn if_none_match_matches(headers: &HeaderMap, etag: &HeaderValue) -> bool {
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

/// Query parameters for `GET /subalbums`.
#[derive(Debug, Deserialize)]
pub struct SubalbumParams {
    album: Option<String>,
    #[serde(default)]
    min_rating: Rating,
}

/// `GET /subalbums?album=/Root/rel&min_rating=` — direct sub-albums of an album,
/// each with a cover (newest photo in its subtree) and recursive photo count,
/// sorted by most recent photo. `min_rating` filters the cover and count alike.
/// An absent/empty `album` lists the album roots.
pub async fn list_subalbums(
    State(state): State<AppState>,
    Query(params): Query<SubalbumParams>,
) -> AppResult<Json<Vec<SubAlbum>>> {
    let album = query::album_segments(params.album.as_deref().unwrap_or_default());

    let filters = Filters {
        min_rating: params.min_rating,
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
    /// Digikam's internal tag root (`_Digikam_Internal_Tags_`); excluded from output.
    const INTERNAL_TAG_ROOT: i64 = 1;

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
