//! `PATCH /api/photos/:id` tag add/remove (`tags_add`/`tags_remove`). Fixture
//! tags: `places(10) > beach(11) > sunset(12)`, internal root 1 with child 2;
//! image 106 carries beach(11) + internal(2), image 107 carries sunset(12).

use axum::http::StatusCode;
use serde_json::json;

use super::Fixture;

/// The photo's tags (absolute paths) as reported by `GET /api/photos/:id`.
async fn tags_of(fx: &Fixture, id: u64) -> Vec<String> {
    let (status, detail) = fx.get_json(&format!("/api/photos/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    detail["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn adds_and_removes_tags() {
    let fx = Fixture::new();
    assert_eq!(tags_of(&fx, 106).await, ["/places/beach"]);

    // Add sunset (12).
    let (status, _) = fx
        .patch_json("/api/photos/106", &json!({ "tags_add": [12] }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        tags_of(&fx, 106).await,
        ["/places/beach", "/places/beach/sunset"]
    );

    // Remove beach (11); sunset stays.
    let (status, _) = fx
        .patch_json("/api/photos/106", &json!({ "tags_remove": [11] }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(tags_of(&fx, 106).await, ["/places/beach/sunset"]);
}

#[tokio::test]
async fn add_and_remove_are_idempotent() {
    let fx = Fixture::new();

    // Adding an already-present tag doesn't duplicate the link.
    let (status, _) = fx
        .patch_json("/api/photos/106", &json!({ "tags_add": [11, 11] }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(tags_of(&fx, 106).await, ["/places/beach"]);
    let links: i64 = fx
        .state
        .pool
        .get()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM ImageTags WHERE imageid = 106 AND tagid = 11",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(links, 1);

    // Removing a tag the photo doesn't carry is a silent no-op.
    let (status, _) = fx
        .patch_json("/api/photos/106", &json!({ "tags_remove": [12] }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(tags_of(&fx, 106).await, ["/places/beach"]);
}

#[tokio::test]
async fn combined_rating_and_tags_patch() {
    let fx = Fixture::new();
    let (status, _) = fx
        .patch_json(
            "/api/photos/107",
            &json!({ "rating": 5, "tags_add": [11], "tags_remove": [12] }),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_s, detail) = fx.get_json("/api/photos/107").await;
    assert_eq!(detail["rating"], json!(5));
    assert_eq!(detail["tags"], json!(["/places/beach"]));
}

#[tokio::test]
async fn rejects_unknown_and_internal_tags() {
    let fx = Fixture::new();

    // Unknown tag id -> 422, and (transaction) the valid add alongside it is
    // rolled back too.
    let (status, body) = fx
        .patch_json("/api/photos/106", &json!({ "tags_add": [12, 999] }))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["error"].as_str().unwrap().contains("999"));
    assert_eq!(tags_of(&fx, 106).await, ["/places/beach"]);

    // Digikam-internal tags (the root and its subtree) are not user tags.
    for tag in [1, 2] {
        let (status, _) = fx
            .patch_json("/api/photos/106", &json!({ "tags_add": [tag] }))
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }
}

#[tokio::test]
async fn forbidden_without_allow_writes() {
    let mut fx = Fixture::new();
    fx.state.allow_writes = false;
    let (status, _) = fx
        .patch_json("/api/photos/106", &json!({ "tags_add": [12] }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(tags_of(&fx, 106).await, ["/places/beach"]);
}
