//! Integration tests for the JSON/HTTP API.
//!
//! Each test builds a [`Fixture`]: a throwaway on-disk SQLite database seeded with
//! a **minimal, entirely synthetic** subset of the Digikam schema (no data from any
//! real collection; the seeding lives in [`crate::fixture`], shared with the
//! Playwright e2e suite's `--seed-fixture`), opened through the same
//! `db::build_pool` the app uses, plus a
//! writable bookmarks DB and an optional thumbnails DB. Requests go through the real
//! router (`crate::build_router`) via `tower`'s `oneshot`, so routing, extractors,
//! status codes, headers, and JSON serialization are all exercised end to end.
//!
//! In-memory SQLite can't be used here: the pool keeps several connections and a
//! plain `:memory:` DB is private per connection, so seeded rows would be invisible.
//! A temp file (seeded by a direct connection, then reopened by the pool) avoids that.

mod bookmarks;
mod files;
mod rating;
mod read;

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Request, StatusCode};
use rusqlite::Connection;
use serde_json::Value;
use tower::ServiceExt;

use crate::db::{self, AppState};
use crate::fixture::{seed_main, seed_thumbs};

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

        // Writable main pool (as with --allow-writes) so the write endpoints are
        // exercised too; a test simulates read-only mode via `allow_writes = false`.
        let pool = db::build_pool(&db_path, false, true).expect("main pool");
        let thumbs = db::build_pool(&thumb_path, false, false).expect("thumb pool");
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
                allow_writes: true,
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

    pub async fn patch_json(&self, uri: &str, body: &Value) -> (StatusCode, Value) {
        let req = Request::patch(uri)
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
