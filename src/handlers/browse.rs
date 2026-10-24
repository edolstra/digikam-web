//! Listing endpoints: the photo grid, `/random`, sub-albums, albums, and tags.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use serde::Deserialize;

use super::{run_blocking, INTERNAL_TAG_ROOT};
use crate::db::{album_display_path, AppState};
use crate::error::{AppError, AppResult};
use crate::models::{AlbumNode, Filters, Page, PhotoSummary, SubAlbum, TagNode};
use crate::query::{self, Aspect, PhotoQuery, Rating, Sort, DEFAULT_LIMIT, MAX_LIMIT};

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
