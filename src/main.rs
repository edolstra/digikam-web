mod config;
mod db;
mod error;
mod handlers;
mod models;
mod query;
mod web;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::routing::get;
use axum::Router;
use clap::Parser;
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::config::Config;
use crate::db::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "digikam_web=info,tower_http=info".into()),
        )
        .init();

    let config = Config::parse();
    tracing::info!(
        database = %config.database.display(),
        mode = if config.allow_writes { "read-write; writes enabled" } else { "read-only" },
        "opening Digikam database"
    );

    let pool = db::build_pool(&config.database, config.trace_sql, config.allow_writes)?;
    let roots = {
        let conn = pool.get().context("failed to get database connection")?;
        db::load_roots(&conn)?
    };
    tracing::info!(roots = roots.len(), "loaded album roots");

    // The thumbnails DB is optional: without it, /thumbnail just 404s.
    let thumb_db = config.thumbnail_db_path();
    let thumbs = match db::build_pool(&thumb_db, config.trace_sql, false) {
        Ok(p) => {
            tracing::info!(path = %thumb_db.display(), "opened thumbnails database (read-only)");
            Some(p)
        }
        Err(e) => {
            tracing::warn!(path = %thumb_db.display(), error = %e,
                "thumbnails database unavailable; /thumbnail will return 404");
            None
        }
    };

    // Our own writable bookmarks DB (web.sql). If it can't be opened, bookmarks
    // are simply unavailable; the rest of the app still works.
    let web_db = config.web_db_path();
    let web = match db::build_web_pool(&web_db, config.trace_sql) {
        Ok(p) => {
            tracing::info!(path = %web_db.display(), "opened bookmarks database (read-write)");
            Some(p)
        }
        Err(e) => {
            tracing::warn!(path = %web_db.display(), error = %e,
                "bookmarks database unavailable; bookmark endpoints will degrade");
            None
        }
    };

    let state = AppState {
        pool,
        thumbs,
        web,
        roots: Arc::new(roots),
        allow_writes: config.allow_writes,
    };

    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .with_context(|| format!("failed to bind {}", config.listen))?;

    tracing::info!(addr = %config.listen, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;
    Ok(())
}

/// Assemble the full application router from an [`AppState`]: the JSON API under
/// `/api`, the SPA shell + static assets at the root, the `/random` redirect, and
/// the request-logging `TraceLayer`. Shared by `main` and the integration tests.
pub(crate) fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(handlers::health))
        .route("/photos", get(handlers::list_photos))
        .route(
            "/photos/:id",
            get(handlers::get_photo).patch(handlers::patch_photo),
        )
        .route("/photos/:id/file", get(handlers::get_photo_file))
        .route("/photos/:id/reverse-search", get(handlers::reverse_search))
        .route("/photos/:id/thumbnail", get(handlers::get_photo_thumbnail))
        .route("/albums", get(handlers::list_albums))
        .route("/subalbums", get(handlers::list_subalbums))
        .route("/tags", get(handlers::list_tags))
        .route(
            "/bookmarks",
            get(handlers::list_bookmarks).post(handlers::create_bookmark),
        )
        .route(
            "/bookmarks/:name",
            axum::routing::delete(handlers::delete_bookmark),
        );

    Router::new()
        .nest("/api", api)
        .route("/", get(web::album_page))
        .route("/photos", get(web::album_page))
        .route("/photos/*path", get(web::album_page))
        .route("/random", get(handlers::random_photo))
        .route("/webpgf.js", get(web::webpgf_js))
        .route("/webpgf.wasm", get(web::webpgf_wasm))
        .route("/favicon.ico", get(web::favicon))
        .route("/manifest.webmanifest", get(web::manifest))
        .route("/sw.js", get(web::service_worker))
        .route("/icon-192.png", get(web::icon_192))
        .route("/icon-512.png", get(web::icon_512))
        // Log each request (method + URI) and its response (status + latency) at
        // INFO; the span carries the URI so it shows on the response line too.
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        )
        .with_state(state)
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
