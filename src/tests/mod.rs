//! Integration tests for the JSON/HTTP API.
//!
//! Each test builds a [`Fixture`]: a throwaway on-disk SQLite database seeded with
//! a **minimal, entirely synthetic** subset of the Digikam schema (no data from any
//! real collection), opened through the same `db::build_pool` the app uses, plus a
//! writable bookmarks DB and an optional thumbnails DB. Requests go through the real
//! router (`crate::build_router`) via `tower`'s `oneshot`, so routing, extractors,
//! status codes, headers, and JSON serialization are all exercised end to end.
//!
//! In-memory SQLite can't be used here: the pool keeps several connections and a
//! plain `:memory:` DB is private per connection, so seeded rows would be invisible.
//! A temp file (seeded read-write, then reopened read-only by the pool) avoids that.

mod bookmarks;
mod files;
mod read;

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Request, StatusCode};
use rusqlite::Connection;
use serde_json::Value;
use tower::ServiceExt;

use crate::db::{self, AppState};

/// A seeded test database + the [`AppState`] over it. Temp dirs are kept alive for
/// the fixture's lifetime and removed on drop.
pub struct Fixture {
    pub state: AppState,
    _dir: tempfile::TempDir,
}

impl Fixture {
    /// Build a fully-populated fixture: main pool, bookmarks pool, and thumbnails
    /// pool, with the synthetic fixture data seeded.
    #[allow(clippy::new_without_default)]
    pub fn new() -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let root_base = dir.path().join("root");
        let db_path = dir.path().join("digikam.db");
        let thumb_path = dir.path().join("thumbnails.db");
        let web_path = dir.path().join("web.sql");

        // Seed the main Digikam DB (read-write), then drop the writer so the
        // read-only pool can open the now-existing file.
        {
            let conn = Connection::open(&db_path).expect("open main db");
            seed_main(&conn, root_base.to_str().expect("utf-8 path"));
        }
        {
            let conn = Connection::open(&thumb_path).expect("open thumb db");
            seed_thumbs(&conn);
        }

        // A real file on disk for the /file endpoint (image 100 in /Animals).
        let animals = root_base.join("Animals");
        std::fs::create_dir_all(&animals).expect("mk album dir");
        std::fs::write(animals.join("img001.jpg"), b"fake-jpeg-bytes").expect("write file");

        let pool = db::build_pool(&db_path, false).expect("main pool");
        let thumbs = db::build_pool(&thumb_path, false).expect("thumb pool");
        let web = db::build_web_pool(&web_path, false).expect("web pool");
        let roots = {
            let conn = pool.get().expect("conn");
            db::load_roots(&conn).expect("roots")
        };

        Fixture {
            state: AppState {
                pool,
                thumbs: Some(thumbs),
                web: Some(web),
                roots: Arc::new(roots),
            },
            _dir: dir,
        }
    }

    // ----- request helpers (each builds a fresh router, then oneshots it) -----

    async fn send(&self, req: Request<Body>) -> (StatusCode, HeaderMap, Bytes) {
        let resp = crate::build_router(self.state.clone())
            .oneshot(req)
            .await
            .expect("router response");
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("collect body");
        (status, headers, body)
    }

    pub async fn get(&self, uri: &str) -> (StatusCode, HeaderMap, Bytes) {
        self.send(Request::get(uri).body(Body::empty()).unwrap())
            .await
    }

    /// GET returning the parsed JSON body (or `Value::Null` for an empty/non-JSON body).
    pub async fn get_json(&self, uri: &str) -> (StatusCode, Value) {
        let (status, _h, body) = self.get(uri).await;
        (status, parse_json(&body))
    }

    /// GET with one extra request header (e.g. `If-None-Match`).
    pub async fn get_with_header(
        &self,
        uri: &str,
        name: &'static str,
        value: &str,
    ) -> (StatusCode, HeaderMap, Bytes) {
        self.send(
            Request::get(uri)
                .header(name, value)
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    pub async fn post_json(&self, uri: &str, body: &Value) -> (StatusCode, Value) {
        let req = Request::post(uri)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(body).unwrap()))
            .unwrap();
        let (status, _h, body) = self.send(req).await;
        (status, parse_json(&body))
    }

    pub async fn delete(&self, uri: &str) -> StatusCode {
        self.send(Request::delete(uri).body(Body::empty()).unwrap())
            .await
            .0
    }
}

fn parse_json(body: &[u8]) -> Value {
    if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(body).unwrap_or(Value::Null)
    }
}

/// Number of items in a `Page<…>` JSON response.
pub fn item_count(page: &Value) -> usize {
    page["items"].as_array().map_or(0, Vec::len)
}

/// Create the minimal Digikam schema and seed the synthetic fixture.
///
/// The data is deliberately fake and small but exercises every query path:
/// multiple albums (root + nested), images vs a video, rated / unrated / trashed /
/// obsolete items, a hierarchical tag tree with its `TagsTree` closure, an internal
/// (excluded) tag, comments, and a GPS position. IDs:
/// - Albums: 1 `/`, 2 `/Animals`, 3 `/Animals/Cats`, 4 `/Beach`.
/// - Images: 100 (5★ landscape, real file + thumbnail), 101 (3★ portrait),
///   102 (video), 103 (unrated, in /Beach), 104 (trashed), 105 (obsolete),
///   106 (the "detail" image: 4★ square in /Beach, comments + GPS + tags beach &
///   internal), 107 (2★, tagged sunset, in /Animals).
/// - Tags: 1 internal root + 2 internal-child; 10 places > 11 beach > 12 sunset.
fn seed_main(conn: &Connection, root_base: &str) {
    conn.execute_batch(
        "CREATE TABLE AlbumRoots(id INTEGER PRIMARY KEY, label TEXT, identifier TEXT, specificPath TEXT);
         CREATE TABLE Albums(id INTEGER PRIMARY KEY, albumRoot INTEGER, relativePath TEXT);
         CREATE TABLE Images(id INTEGER PRIMARY KEY, album INTEGER, name TEXT, status INTEGER,
                             fileSize INTEGER, uniqueHash TEXT, modificationDate TEXT, category INTEGER);
         CREATE TABLE ImageInformation(imageid INTEGER PRIMARY KEY, rating INTEGER, creationDate TEXT,
                             width INTEGER, height INTEGER, format TEXT);
         CREATE TABLE ImageComments(id INTEGER PRIMARY KEY, imageid INTEGER, type INTEGER, language TEXT, comment TEXT);
         CREATE TABLE ImagePositions(imageid INTEGER PRIMARY KEY, latitudeNumber REAL, longitudeNumber REAL);
         CREATE TABLE Tags(id INTEGER PRIMARY KEY, pid INTEGER, name TEXT);
         CREATE TABLE TagsTree(id INTEGER, pid INTEGER);
         CREATE TABLE ImageTags(imageid INTEGER, tagid INTEGER);

         INSERT INTO Albums(id, albumRoot, relativePath) VALUES
           (1, 1, '/'), (2, 1, '/Animals'), (3, 1, '/Animals/Cats'), (4, 1, '/Beach');

         -- status 1 = visible; 3 = trashed, 4 = obsolete (both must be excluded).
         -- category 2 = video. modificationDate drives ordering (newest first).
         INSERT INTO Images(id, album, name, status, fileSize, uniqueHash, modificationDate, category) VALUES
           (100, 2, 'img001.jpg',  1, 1000, 'hash100', '2024-01-05T10:00:00', 1),
           (101, 3, 'img002.jpg',  1, 2000, 'hash101', '2024-01-04T10:00:00', 1),
           (102, 2, 'clip001.mp4', 1, 3000, 'hash102', '2024-01-03T10:00:00', 2),
           (103, 4, 'img003.jpg',  1, 4000, 'hash103', '2024-01-02T10:00:00', 1),
           (104, 2, 'trashed.jpg', 3, 5000, 'hash104', '2024-01-07T10:00:00', 1),
           (105, 2, 'obsol.jpg',   4, 5500, 'hash105', '2024-01-08T10:00:00', 1),
           (106, 4, 'detail.jpg',  1, 6000, 'hash106', '2024-01-06T10:00:00', 1),
           (107, 2, 'tagged.jpg',  1, 7000, 'hash107', '2024-01-01T10:00:00', 1);

         -- rating -1 = unrated. Dimensions drive the aspect filter.
         INSERT INTO ImageInformation(imageid, rating, creationDate, width, height, format) VALUES
           (100,  5, '2023-12-01T09:00:00', 4000, 3000, 'JPG'),
           (101,  3, '2023-12-02T09:00:00', 3000, 4000, 'JPG'),
           (102,  0, '2023-12-03T09:00:00', 1920, 1080, 'MP4'),
           (103, -1, '2023-12-04T09:00:00', 4000, 3000, 'JPG'),
           (106,  4, '2023-11-15T08:30:00', 3000, 3000, 'JPG'),
           (107,  2, '2023-12-05T09:00:00', 4000, 3000, 'JPG');

         -- Two comments on image 106 -> newline-joined description.
         INSERT INTO ImageComments(id, imageid, type, language, comment) VALUES
           (1, 106, 1, 'x-default', 'caption one'),
           (2, 106, 1, 'x-default', 'caption two');

         INSERT INTO ImagePositions(imageid, latitudeNumber, longitudeNumber) VALUES
           (106, 12.34, 56.78);

         -- Tag 1 is Digikam's reserved internal root (excluded everywhere); 2 is a
         -- child of it. 10/11/12 are a normal hierarchy /places/beach/sunset.
         INSERT INTO Tags(id, pid, name) VALUES
           (1, 0, '_Digikam_Internal_Tags_'), (2, 1, 'internal-child'),
           (10, 0, 'places'), (11, 10, 'beach'), (12, 11, 'sunset');

         -- TagsTree(id, pid): id is a strict descendant of pid (closure).
         INSERT INTO TagsTree(id, pid) VALUES
           (2, 1), (11, 10), (12, 11), (12, 10);

         INSERT INTO ImageTags(imageid, tagid) VALUES
           (106, 11), (106, 2), (107, 12);",
    )
    .expect("seed main schema");

    conn.execute(
        "INSERT INTO AlbumRoots(id, label, identifier, specificPath) \
         VALUES (1, 'Collection', ?1, '/')",
        [format!("volumeid:?path={root_base}&fileuuid=test")],
    )
    .expect("seed album root");
}

/// Seed the thumbnails DB: one cached thumbnail for image 100 (keyed by its
/// uniqueHash + fileSize), with an orientation hint.
fn seed_thumbs(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE UniqueHashes(uniqueHash TEXT, fileSize INTEGER, thumbId INTEGER);
         CREATE TABLE Thumbnails(id INTEGER PRIMARY KEY, data BLOB, orientationHint INTEGER);
         INSERT INTO Thumbnails(id, data, orientationHint) VALUES (1, x'0102030405', 6);
         INSERT INTO UniqueHashes(uniqueHash, fileSize, thumbId) VALUES ('hash100', 1000, 1);",
    )
    .expect("seed thumbs");
}
