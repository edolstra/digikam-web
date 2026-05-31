mod config;
mod db;
mod error;
mod handlers;
mod models;
mod query;

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::routing::get;
use axum::Router;
use clap::Parser;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

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

    let state = AppState {
        pool,
        roots: Arc::new(roots),
    };

    let api = Router::new()
        .route("/health", get(handlers::health))
        .route("/photos", get(handlers::list_photos))
        .route("/photos/:id", get(handlers::get_photo))
        .route("/photos/:id/file", get(handlers::get_photo_file))
        .route("/albums", get(handlers::list_albums))
        .route("/tags", get(handlers::list_tags));

    let app = Router::new()
        .nest("/api", api)
        .layer(TraceLayer::new_for_http())
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
