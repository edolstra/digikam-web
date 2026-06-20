//! Bookmarks CRUD against the writable `web.sql` pool.

use axum::http::StatusCode;
use serde_json::json;

use super::Fixture;

fn sample(name: &str) -> serde_json::Value {
    json!({
        "name": name,
        "album": "/Collection/Beach",
        "recursive": true,
        "min_rating": 2,
        "include_images": true,
        "include_video": false,
        "aspect": "portrait",
        "tags": ["beach"],
    })
}

#[tokio::test]
async fn create_list_delete_round_trip() {
    let fx = Fixture::new();

    // Starts empty.
    let (status, list) = fx.get_json("/api/bookmarks").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 0);

    // Create.
    let (status, _b) = fx.post_json("/api/bookmarks", &sample("trip")).await;
    assert_eq!(status, StatusCode::OK);

    // Read back — fields (incl. tags) round-trip via the flattened Filters.
    let (_s, list) = fx.get_json("/api/bookmarks").await;
    let arr = list.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    let b = &arr[0];
    assert_eq!(b["name"], "trip");
    assert_eq!(b["album"], "/Collection/Beach");
    assert_eq!(b["recursive"], true);
    assert_eq!(b["min_rating"], 2);
    assert_eq!(b["include_video"], false);
    assert_eq!(b["aspect"], "portrait");
    assert_eq!(b["tags"], json!(["beach"]));

    // Delete is 204 and idempotent.
    assert_eq!(
        fx.delete("/api/bookmarks/trip").await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        fx.delete("/api/bookmarks/trip").await,
        StatusCode::NO_CONTENT
    );
    let (_s, list) = fx.get_json("/api/bookmarks").await;
    assert_eq!(list.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn duplicate_requires_overwrite() {
    let fx = Fixture::new();
    let (status, _b) = fx.post_json("/api/bookmarks", &sample("dup")).await;
    assert_eq!(status, StatusCode::OK);
    // Same name again -> conflict.
    let (status, _b) = fx.post_json("/api/bookmarks", &sample("dup")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    // With overwrite -> replaces.
    let mut body = sample("dup");
    body["overwrite"] = json!(true);
    body["min_rating"] = json!(4);
    let (status, _b) = fx.post_json("/api/bookmarks", &body).await;
    assert_eq!(status, StatusCode::OK);
    let (_s, list) = fx.get_json("/api/bookmarks").await;
    assert_eq!(list[0]["min_rating"], 4);
}

#[tokio::test]
async fn validation_errors() {
    let fx = Fixture::new();

    // Empty name -> 400.
    let mut body = sample("x");
    body["name"] = json!("   ");
    let (status, _b) = fx.post_json("/api/bookmarks", &body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Bad min_rating (out of 0..=5) -> 422 typed-body rejection.
    let mut body = sample("y");
    body["min_rating"] = json!(9);
    let (status, _b) = fx.post_json("/api/bookmarks", &body).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Bad aspect -> 422.
    let mut body = sample("z");
    body["aspect"] = json!("diagonal");
    let (status, _b) = fx.post_json("/api/bookmarks", &body).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn degraded_without_web_pool() {
    let mut fx = Fixture::new();
    fx.state.web = None;
    // Listing degrades gracefully to an empty array.
    let (status, list) = fx.get_json("/api/bookmarks").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 0);
}
