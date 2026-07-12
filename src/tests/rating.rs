//! `PATCH /api/photos/:id` — the rating write endpoint (the fixture's main pool
//! is writable, as with `--allow-writes`).

use axum::http::StatusCode;
use serde_json::json;

use super::{item_count, Fixture};

/// The photo's rating as reported by `GET /api/photos/:id`.
async fn rating_of(fx: &Fixture, id: u64) -> serde_json::Value {
    let (status, detail) = fx.get_json(&format!("/api/photos/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    detail["rating"].clone()
}

#[tokio::test]
async fn sets_and_clears_rating() {
    let fx = Fixture::new();

    // 101 starts at 3★; set it to 5.
    assert_eq!(rating_of(&fx, 101).await, json!(3));
    let (status, _) = fx
        .patch_json("/api/photos/101", &json!({ "rating": 5 }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(rating_of(&fx, 101).await, json!(5));

    // Clear back to unrated (-1 in the DB, null in the API).
    let (status, _) = fx
        .patch_json("/api/photos/101", &json!({ "rating": null }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(rating_of(&fx, 101).await, json!(null));
}

#[tokio::test]
async fn rating_change_affects_min_rating_filter() {
    let fx = Fixture::new();

    // /Beach holds 103 (unrated) and 106 (4★): only 106 passes min_rating=4.
    let uri = "/api/photos?album=/Collection/Beach&min_rating=4";
    let (_s, page) = fx.get_json(uri).await;
    assert_eq!(item_count(&page), 1);

    let (status, _) = fx
        .patch_json("/api/photos/103", &json!({ "rating": 5 }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_s, page) = fx.get_json(uri).await;
    assert_eq!(item_count(&page), 2);
}

#[tokio::test]
async fn upserts_missing_image_information_row() {
    let fx = Fixture::new();

    // A visible image with no ImageInformation row at all (the fixture's status-1
    // images all have one, so add our own through the now-writable pool).
    fx.state
        .pool
        .get()
        .unwrap()
        .execute(
            "INSERT INTO Images(id, album, name, status, fileSize, uniqueHash, modificationDate, category) \
             VALUES (108, 2, 'norow.jpg', 1, 8000, 'hash108', '2024-01-09T10:00:00', 1)",
            [],
        )
        .unwrap();

    assert_eq!(rating_of(&fx, 108).await, json!(null));
    let (status, _) = fx
        .patch_json("/api/photos/108", &json!({ "rating": 2 }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(rating_of(&fx, 108).await, json!(2));
}

#[tokio::test]
async fn empty_patch_is_a_no_op() {
    let fx = Fixture::new();
    let (status, _) = fx.patch_json("/api/photos/101", &json!({})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(rating_of(&fx, 101).await, json!(3));
}

#[tokio::test]
async fn validation_and_missing_photos() {
    let fx = Fixture::new();

    // Out-of-range rating -> 422 typed-body rejection (like bookmarks' min_rating).
    let (status, _) = fx
        .patch_json("/api/photos/101", &json!({ "rating": 9 }))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Unknown and trashed (status 3) images -> 404.
    let (status, _) = fx
        .patch_json("/api/photos/999", &json!({ "rating": 1 }))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = fx
        .patch_json("/api/photos/104", &json!({ "rating": 1 }))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn forbidden_without_allow_writes() {
    let mut fx = Fixture::new();
    fx.state.allow_writes = false;
    let (status, body) = fx
        .patch_json("/api/photos/101", &json!({ "rating": 5 }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body["error"].as_str().unwrap().contains("--allow-writes"));
    // Nothing changed.
    assert_eq!(rating_of(&fx, 101).await, json!(3));
}
