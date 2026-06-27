//! Read endpoints: `/api/health`, `/api/photos`, `/api/photos/:id`, `/api/albums`,
//! `/api/subalbums`, `/api/tags`, and the root `/random` redirect.

use axum::http::StatusCode;

use super::{item_count, Fixture};

#[tokio::test]
async fn health_ok() {
    let fx = Fixture::new();
    let (status, body) = fx.get_json("/api/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn photos_recursive_lists_all_visible() {
    let fx = Fixture::new();
    let (status, page) = fx.get_json("/api/photos?album=&recursive=true").await;
    assert_eq!(status, StatusCode::OK);
    // 6 visible images (100,101,102,103,106,107); 104 (trashed) + 105 (obsolete) excluded.
    assert_eq!(item_count(&page), 6);
    assert!(!page["incomplete"].as_bool().unwrap());
    // Trashed / obsolete items must never surface.
    let names: Vec<&str> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    assert!(!names.contains(&"trashed.jpg"));
    assert!(!names.contains(&"obsol.jpg"));
}

/// The `name` field of every item in a `Page<…>`, in order.
fn names(page: &serde_json::Value) -> Vec<&str> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn photos_sort_orders() {
    let fx = Fixture::new();

    // Default (modified, newest first).
    let (status, page) = fx.get_json("/api/photos?album=&recursive=true").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        names(&page),
        [
            "detail.jpg",
            "img001.jpg",
            "img002.jpg",
            "clip001.mp4",
            "img003.jpg",
            "tagged.jpg"
        ]
    );

    // Created date, newest first (distinct from the modified order).
    let (_s, page) = fx
        .get_json("/api/photos?album=&recursive=true&sort=created")
        .await;
    assert_eq!(
        names(&page),
        [
            "tagged.jpg",
            "img003.jpg",
            "clip001.mp4",
            "img002.jpg",
            "img001.jpg",
            "detail.jpg"
        ]
    );

    // Name, ascending (case-insensitive).
    let (_s, page) = fx
        .get_json("/api/photos?album=&recursive=true&sort=name")
        .await;
    assert_eq!(
        names(&page),
        [
            "clip001.mp4",
            "detail.jpg",
            "img001.jpg",
            "img002.jpg",
            "img003.jpg",
            "tagged.jpg"
        ]
    );

    // An unknown sort value is rejected.
    let (status, _b) = fx.get_json("/api/photos?album=&sort=bogus").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn subalbums_sort_name_is_alphabetical() {
    let fx = Fixture::new();
    // Default order is by most recent photo: Beach (img 106, 01-06) before
    // Animals (img 100, 01-05).
    let (_s, subs) = fx.get_json("/api/subalbums?album=/Collection").await;
    let order: Vec<&str> = subs
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(order, ["Beach", "Animals"]);

    // sort=name lists them alphabetically instead.
    let (_s, subs) = fx
        .get_json("/api/subalbums?album=/Collection&sort=name")
        .await;
    let order: Vec<&str> = subs
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(order, ["Animals", "Beach"]);
}

#[tokio::test]
async fn subalbums_cover_respects_sort() {
    let fx = Fixture::new();

    // Default (modified): the cover is the newest item in each subtree.
    let (_s, subs) = fx.get_json("/api/subalbums?album=/Collection").await;
    let cover = |name: &str| -> serde_json::Value {
        subs.as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == name)
            .unwrap()["cover"]
            .clone()
    };
    assert_eq!(cover("Animals")["id"], 100); // img001.jpg, newest in /Animals
    assert_eq!(cover("Beach")["id"], 106); // detail.jpg, newest in /Beach

    // sort=name: the cover is the alphabetically-first item (matching the grid).
    let (_s, subs) = fx
        .get_json("/api/subalbums?album=/Collection&sort=name")
        .await;
    let cover = |name: &str| -> serde_json::Value {
        subs.as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == name)
            .unwrap()["cover"]
            .clone()
    };
    // In /Animals, 'clip001.mp4' sorts before 'img001.jpg' — a video cover.
    assert_eq!(cover("Animals")["id"], 102);
    assert_eq!(cover("Animals")["is_video"], true);
    // In /Beach, 'detail.jpg' sorts before 'img003.jpg'.
    assert_eq!(cover("Beach")["id"], 106);
}

#[tokio::test]
async fn photos_empty_album_non_recursive_is_empty() {
    let fx = Fixture::new();
    let (status, page) = fx.get_json("/api/photos?album=").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(item_count(&page), 0);
}

#[tokio::test]
async fn photos_album_scope_and_recursion() {
    let fx = Fixture::new();
    // Directly in /Animals: img001 (100), clip001 (102), tagged (107).
    let (_s, page) = fx.get_json("/api/photos?album=/Collection/Animals").await;
    assert_eq!(item_count(&page), 3);
    // Recursive also pulls /Animals/Cats (img002, 101).
    let (_s, page) = fx
        .get_json("/api/photos?album=/Collection/Animals&recursive=true")
        .await;
    assert_eq!(item_count(&page), 4);
}

#[tokio::test]
async fn photos_min_rating() {
    let fx = Fixture::new();
    // Only the 5★ image.
    let (_s, page) = fx
        .get_json("/api/photos?album=&recursive=true&min_rating=5")
        .await;
    assert_eq!(item_count(&page), 1);
    // >=1 excludes the unrated (103, rating -1) and the rating-0 video (102): 4 left.
    let (_s, page) = fx
        .get_json("/api/photos?album=&recursive=true&min_rating=1")
        .await;
    assert_eq!(item_count(&page), 4);
    // Out of range -> 400.
    let (status, _b) = fx
        .get_json("/api/photos?album=&recursive=true&min_rating=9")
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn photos_media_type_filter() {
    let fx = Fixture::new();
    // video=false -> images only (5 of 6).
    let (_s, page) = fx
        .get_json("/api/photos?album=&recursive=true&video=false")
        .await;
    assert_eq!(item_count(&page), 5);
    // images=false -> just the one video.
    let (_s, page) = fx
        .get_json("/api/photos?album=&recursive=true&images=false")
        .await;
    assert_eq!(item_count(&page), 1);
    assert!(page["items"][0]["is_video"].as_bool().unwrap());
}

#[tokio::test]
async fn photos_aspect_filter() {
    let fx = Fixture::new();
    // Portrait: 101 (3000x4000) and 106 (square, inclusive).
    let (_s, page) = fx
        .get_json("/api/photos?album=&recursive=true&aspect=portrait")
        .await;
    assert_eq!(item_count(&page), 2);
    // Landscape: everything with width>=height (square counts) -> 5.
    let (_s, page) = fx
        .get_json("/api/photos?album=&recursive=true&aspect=landscape")
        .await;
    assert_eq!(item_count(&page), 5);
}

#[tokio::test]
async fn photos_tag_filter_matches_tag_tree_and_album_name() {
    let fx = Fixture::new();
    // `beach` matches: images under the /Beach album (103, 106) plus images tagged
    // beach or a subtag (106 beach, 107 sunset) -> {103, 106, 107}.
    let (status, page) = fx
        .get_json("/api/photos?album=&recursive=true&tags=beach")
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(item_count(&page), 3);
}

#[tokio::test]
async fn photos_paging_incomplete() {
    let fx = Fixture::new();
    let (_s, page) = fx
        .get_json("/api/photos?album=&recursive=true&limit=1")
        .await;
    assert_eq!(item_count(&page), 1);
    assert!(page["incomplete"].as_bool().unwrap());
}

#[tokio::test]
async fn photo_detail() {
    let fx = Fixture::new();
    let (status, d) = fx.get_json("/api/photos/106").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(d["name"], "detail.jpg");
    assert_eq!(d["album_path"], "/Collection/Beach");
    // Comments concatenated with a newline.
    assert_eq!(d["description"], "caption one\ncaption two");
    assert_eq!(d["creation_date"], "2023-11-15T08:30:00");
    assert_eq!(d["latitude"], 12.34);
    assert_eq!(d["longitude"], 56.78);
    // Absolute server path ends at the album-relative file location.
    assert!(d["file_path"]
        .as_str()
        .unwrap()
        .ends_with("/Beach/detail.jpg"));
    // Tags are absolute paths; the internal tag (id 2) is excluded.
    let tags: Vec<&str> = d["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    assert_eq!(tags, ["/places/beach"]);
}

#[tokio::test]
async fn photo_detail_missing_is_404() {
    let fx = Fixture::new();
    let (status, _b) = fx.get_json("/api/photos/9999").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn albums_lists_all() {
    let fx = Fixture::new();
    let (status, albums) = fx.get_json("/api/albums").await;
    assert_eq!(status, StatusCode::OK);
    let paths: Vec<&str> = albums
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["path"].as_str().unwrap())
        .collect();
    assert_eq!(albums.as_array().unwrap().len(), 4);
    assert!(paths.contains(&"/Collection"));
    assert!(paths.contains(&"/Collection/Animals"));
    assert!(paths.contains(&"/Collection/Animals/Cats"));
    assert!(paths.contains(&"/Collection/Beach"));
}

#[tokio::test]
async fn subalbums_root_lists_roots() {
    let fx = Fixture::new();
    let (status, subs) = fx.get_json("/api/subalbums?album=").await;
    assert_eq!(status, StatusCode::OK);
    let arr = subs.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["name"], "Collection");
    assert_eq!(arr[0]["photo_count"], 6); // whole subtree incl. the video
    assert_eq!(arr[0]["cover"]["id"], 106); // newest visible item
}

#[tokio::test]
async fn subalbums_of_album() {
    let fx = Fixture::new();
    let (_s, subs) = fx.get_json("/api/subalbums?album=/Collection").await;
    let by_name: std::collections::HashMap<&str, &serde_json::Value> = subs
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["name"].as_str().unwrap(), s))
        .collect();
    assert_eq!(by_name.len(), 2);
    assert_eq!(by_name["Animals"]["photo_count"], 4);
    assert_eq!(by_name["Beach"]["photo_count"], 2);
    // A filter narrows it: only /Beach has 5★? no — min_rating=5 keeps just image 100 (Animals).
    let (_s, subs) = fx
        .get_json("/api/subalbums?album=/Collection&min_rating=5")
        .await;
    let names: Vec<&str> = subs
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Animals"]);
}

#[tokio::test]
async fn tags_tree_excludes_internal() {
    let fx = Fixture::new();
    let (status, tree) = fx.get_json("/api/tags").await;
    assert_eq!(status, StatusCode::OK);
    let top = tree.as_array().unwrap();
    // Only `places` at the top; the internal root (id 1) and its child are gone.
    assert_eq!(top.len(), 1);
    assert_eq!(top[0]["name"], "places");
    assert_eq!(top[0]["children"][0]["name"], "beach");
    assert_eq!(top[0]["children"][0]["children"][0]["name"], "sunset");
}

#[tokio::test]
async fn random_redirects_to_a_matching_file() {
    let fx = Fixture::new();
    let (status, headers, _b) = fx.get("/random?album=&recursive=true&video=false").await;
    assert_eq!(status, StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
    let loc = headers.get("location").unwrap().to_str().unwrap();
    assert!(loc.starts_with("/api/photos/"));
    assert!(loc.ends_with("/file"));
}

#[tokio::test]
async fn random_empty_album_is_404() {
    let fx = Fixture::new();
    let (status, _h, _b) = fx.get("/random?album=").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
