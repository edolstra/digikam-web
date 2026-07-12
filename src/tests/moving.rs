//! `PATCH /api/photos/:id` album moves (`album`): the DB row and the file on
//! disk move together (same-filesystem rename), or not at all. Fixture: image
//! 100 (`img001.jpg`) lives in album 2 (`/Animals`) with a real file at
//! `root/Animals/img001.jpg`; albums 3 (`/Animals/Cats`) and 4 (`/Beach`) have
//! no directory on disk until a test creates one.

use axum::http::StatusCode;
use serde_json::json;

use super::Fixture;

/// The photo's album display path per `GET /api/photos/:id`.
async fn album_of(fx: &Fixture, id: u64) -> String {
    let (status, detail) = fx.get_json(&format!("/api/photos/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    detail["album_path"].as_str().unwrap().to_string()
}

/// `Images.album` straight from the DB.
fn db_album(fx: &Fixture, id: i64) -> i64 {
    fx.state
        .pool
        .get()
        .unwrap()
        .query_row("SELECT album FROM Images WHERE id = ?1", [id], |r| r.get(0))
        .unwrap()
}

#[tokio::test]
async fn moves_photo_and_file_there_and_back() {
    let fx = Fixture::new();
    let beach = fx.root_base.join("Beach");
    std::fs::create_dir_all(&beach).unwrap();
    let old_file = fx.root_base.join("Animals/img001.jpg");
    let new_file = beach.join("img001.jpg");
    assert!(old_file.exists());

    // Move to /Beach (album 4).
    let (status, _) = fx
        .patch_json("/api/photos/100", &json!({ "album": 4 }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(album_of(&fx, 100).await, "/Collection/Beach");
    assert_eq!(db_album(&fx, 100), 4);
    assert!(new_file.exists() && !old_file.exists());

    // And back (the undo direction).
    let (status, _) = fx
        .patch_json("/api/photos/100", &json!({ "album": 2 }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(album_of(&fx, 100).await, "/Collection/Animals");
    assert!(old_file.exists() && !new_file.exists());
}

#[tokio::test]
async fn same_album_is_a_no_op() {
    let fx = Fixture::new();
    let (status, _) = fx
        .patch_json("/api/photos/100", &json!({ "album": 2 }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(fx.root_base.join("Animals/img001.jpg").exists());
}

#[tokio::test]
async fn rejects_unknown_album() {
    let fx = Fixture::new();
    let (status, body) = fx
        .patch_json("/api/photos/100", &json!({ "album": 999 }))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["error"].as_str().unwrap().contains("999"));
    assert_eq!(db_album(&fx, 100), 2);
}

#[tokio::test]
async fn name_collision_is_a_conflict() {
    let fx = Fixture::new();
    let beach = fx.root_base.join("Beach");
    std::fs::create_dir_all(&beach).unwrap();
    std::fs::write(beach.join("img001.jpg"), b"already here").unwrap();

    let (status, body) = fx
        .patch_json("/api/photos/100", &json!({ "album": 4 }))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body["error"].as_str().unwrap().contains("img001.jpg"));
    // Nothing moved.
    assert_eq!(db_album(&fx, 100), 2);
    assert!(fx.root_base.join("Animals/img001.jpg").exists());
}

#[tokio::test]
async fn missing_target_directory_is_a_conflict() {
    let fx = Fixture::new();
    // Album 4 (/Beach) exists in the DB but its directory was never created.
    let (status, body) = fx
        .patch_json("/api/photos/100", &json!({ "album": 4 }))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body["error"].as_str().unwrap().contains("Beach"));
    assert_eq!(db_album(&fx, 100), 2);
}

#[tokio::test]
async fn missing_source_file_rolls_back() {
    let fx = Fixture::new();
    let beach = fx.root_base.join("Beach");
    std::fs::create_dir_all(&beach).unwrap();
    // Image 103 (img003.jpg, in album 4 /Beach) has no file on disk, so the
    // rename fails after the DB update — which must roll back.
    let (status, body) = fx
        .patch_json("/api/photos/103", &json!({ "album": 2 }))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body["error"].as_str().unwrap().contains("img003.jpg"));
    assert_eq!(db_album(&fx, 103), 4);
}

#[tokio::test]
async fn failing_move_rolls_back_the_whole_patch() {
    let fx = Fixture::new();
    // Combined rating + move where the move fails (no /Beach directory): the
    // rating change must be rolled back too (one transaction).
    let (status, _) = fx
        .patch_json("/api/photos/100", &json!({ "rating": 1, "album": 4 }))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_s, detail) = fx.get_json("/api/photos/100").await;
    assert_eq!(detail["rating"], json!(5)); // unchanged
}

#[tokio::test]
async fn combined_rating_and_move() {
    let fx = Fixture::new();
    std::fs::create_dir_all(fx.root_base.join("Beach")).unwrap();
    let (status, _) = fx
        .patch_json("/api/photos/100", &json!({ "rating": 1, "album": 4 }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_s, detail) = fx.get_json("/api/photos/100").await;
    assert_eq!(detail["rating"], json!(1));
    assert_eq!(detail["album_path"], "/Collection/Beach");
}

#[tokio::test]
async fn forbidden_without_allow_writes() {
    let mut fx = Fixture::new();
    fx.state.allow_writes = false;
    let (status, _) = fx
        .patch_json("/api/photos/100", &json!({ "album": 4 }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(db_album(&fx, 100), 2);
}
