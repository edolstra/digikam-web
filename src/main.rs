mod config;
mod db;
mod error;
mod handlers;
mod models;
mod query;
mod web;

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::routing::get;
use axum::Router;
use clap::Parser;
use tower_http::cors::CorsLayer;
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::config::Config;
use crate::db::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "digikam_browse=info,tower_http=info".into()),
        )
        .init();

    let config = Config::parse();
    tracing::info!(database = %config.database.display(), "opening Digikam database (read-only)");

    let pool = db::build_pool(&config.database, config.trace_sql)?;
    let roots = {
        let conn = pool.get().context("failed to get database connection")?;
        db::load_roots(&conn)?
    };
    tracing::info!(roots = roots.len(), "loaded album roots");

    // The thumbnails DB is optional: without it, /thumbnail just 404s.
    let thumb_db = config.thumbnail_db_path();
    let thumbs = match db::build_pool(&thumb_db, config.trace_sql) {
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

    let state = AppState {
        pool,
        thumbs,
        roots: Arc::new(roots),
    };

    let api = Router::new()
        .route("/health", get(handlers::health))
        .route("/photos", get(handlers::list_photos))
        .route("/photos/:id", get(handlers::get_photo))
        .route("/photos/:id/file", get(handlers::get_photo_file))
        .route("/photos/:id/thumbnail", get(handlers::get_photo_thumbnail))
        .route("/albums", get(handlers::list_albums))
        .route("/subalbums", get(handlers::list_subalbums))
        .route("/tags", get(handlers::list_tags));

    let app = Router::new()
        .nest("/api", api)
        .route("/", get(web::album_page))
        .route("/photos", get(web::album_page))
        .route("/photos/*path", get(web::album_page))
        .route("/webpgf.js", get(web::webpgf_js))
        .route("/webpgf.wasm", get(web::webpgf_wasm))
        // Log each request (method + URI) and its response (status + latency) at
        // INFO; the span carries the URI so it shows on the response line too.
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        )
        .layer(CorsLayer::permissive())
        .with_state(state);

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

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
