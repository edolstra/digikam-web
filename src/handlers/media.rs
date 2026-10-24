//! Serving a photo's bytes: the original (`/file`), Digikam's stored thumbnail
//! (`/thumbnail`), and the Yandex reverse-image-search upload.

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Request};
use axum::response::{IntoResponse, Redirect, Response};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use super::{load_image, run_blocking};
use crate::db::AppState;
use crate::error::{AppError, AppResult};
use crate::http::{self, IMMUTABLE_CACHE_CONTROL};

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
        let img = load_image(conn, id)?;
        Ok((img.abs_path(&state.roots)?, img.name))
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
        let img = load_image(conn, id)?;

        // Build a strong ETag from the content hash; skip if Digikam has none.
        let etag = img
            .unique_hash
            .as_deref()
            .filter(|h| !h.is_empty())
            .and_then(|h| HeaderValue::from_str(&format!("\"{h}\"")).ok());

        Ok((img.abs_path(&state.roots)?, etag, img.name))
    })
    .await?;

    // If the client already holds this exact content, don't re-send it.
    if let Some(etag) = &etag {
        if let Some(not_modified) = http::not_modified(request.headers(), etag, None) {
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
        let img = load_image(conn, id)?;
        let (Some(hash), Some(size)) = (img.unique_hash, img.file_size) else {
            return Err(AppError::NotFound(format!("no thumbnail for photo {id}")));
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
        if let Some(not_modified) =
            http::not_modified(&headers, etag, Some(IMMUTABLE_CACHE_CONTROL))
        {
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
