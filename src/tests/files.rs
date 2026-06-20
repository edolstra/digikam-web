//! Binary endpoints: `/file`, `/thumbnail`, and the non-network error paths of
//! `/reverse-search`.

use axum::http::StatusCode;

use super::Fixture;

#[tokio::test]
async fn file_serves_bytes_with_etag_and_disposition() {
    let fx = Fixture::new();
    let (status, headers, body) = fx.get("/api/photos/100/file").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(&body[..], b"fake-jpeg-bytes");
    assert_eq!(headers.get("etag").unwrap(), "\"hash100\"");
    let cd = headers
        .get("content-disposition")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cd.starts_with("inline"));
    assert!(cd.contains("img001.jpg"));
}

#[tokio::test]
async fn file_if_none_match_is_304() {
    let fx = Fixture::new();
    let (status, _h, body) = fx
        .get_with_header("/api/photos/100/file", "if-none-match", "\"hash100\"")
        .await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert!(body.is_empty());
}

#[tokio::test]
async fn file_unknown_id_is_404() {
    let fx = Fixture::new();
    let (status, _h, _b) = fx.get("/api/photos/9999/file").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn thumbnail_serves_blob_with_orientation() {
    let fx = Fixture::new();
    let (status, headers, body) = fx.get("/api/photos/100/thumbnail").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(&body[..], &[1u8, 2, 3, 4, 5]);
    assert_eq!(headers.get("x-orientation").unwrap(), "6");
    assert_eq!(headers.get("etag").unwrap(), "\"hash100-thumb\"");
    assert!(headers
        .get("cache-control")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("immutable"));
}

#[tokio::test]
async fn thumbnail_if_none_match_is_304() {
    let fx = Fixture::new();
    let (status, _h, _b) = fx
        .get_with_header(
            "/api/photos/100/thumbnail",
            "if-none-match",
            "\"hash100-thumb\"",
        )
        .await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn thumbnail_missing_is_404() {
    let fx = Fixture::new();
    // Image 101 has no cached thumbnail row.
    let (status, _h, _b) = fx.get("/api/photos/101/thumbnail").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn thumbnail_without_thumbs_pool_is_404() {
    let mut fx = Fixture::new();
    fx.state.thumbs = None;
    let (status, _h, _b) = fx.get("/api/photos/100/thumbnail").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn reverse_search_unsupported_engine_is_400() {
    let fx = Fixture::new();
    // Engine is validated before any DB/network work.
    let (status, _h, _b) = fx.get("/api/photos/100/reverse-search?engine=google").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn reverse_search_unknown_id_is_404() {
    let fx = Fixture::new();
    // Unknown id fails path resolution before the (real) Yandex upload is attempted.
    let (status, _h, _b) = fx
        .get("/api/photos/9999/reverse-search?engine=yandex")
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
