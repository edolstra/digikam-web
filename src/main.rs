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
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .with_context(|| format!("failed to bind {}", config.listen))?;

    if config.tls {
        tracing::info!(addr = %config.listen, "listening (HTTPS + HTTP/2, self-signed cert)");
        serve_tls(listener, app).await?;
    } else {
        tracing::info!(addr = %config.listen, "listening (HTTP/1.1)");
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown_signal())
            .await
            .context("server error")?;
    }
    Ok(())
}

/// Serve over TLS with an auto-generated self-signed certificate, negotiating
/// HTTP/2 (ALPN `h2`, falling back to HTTP/1.1) via hyper's auto builder.
async fn serve_tls(listener: tokio::net::TcpListener, app: Router) -> Result<()> {
    use hyper_util::rt::{TokioExecutor, TokioIo};
    use hyper_util::server::conn::auto::Builder;

    let tls = Arc::new(self_signed_tls_config().context("building TLS config")?);
    let acceptor = tokio_rustls::TlsAcceptor::from(tls);

    let mut shutdown = std::pin::pin!(shutdown_signal());
    loop {
        let (stream, _peer) = tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => match accepted {
                Ok(s) => s,
                Err(e) => { tracing::warn!(error = %e, "accept failed"); continue; }
            },
        };
        let acceptor = acceptor.clone();
        let app = app.clone();
        tokio::spawn(async move {
            // A failed handshake (e.g. a plain-HTTP probe) just drops the conn.
            let Ok(stream) = acceptor.accept(stream).await else {
                return;
            };
            let io = TokioIo::new(stream);
            let service =
                hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                    use tower::Service;
                    app.clone().call(req.map(axum::body::Body::new))
                });
            if let Err(e) = Builder::new(TokioExecutor::new())
                .serve_connection(io, service)
                .await
            {
                tracing::debug!(error = %e, "connection closed with error");
            }
        });
    }
    Ok(())
}

/// Build a rustls server config with a freshly generated self-signed certificate
/// (for `localhost`/loopback) and ALPN advertising HTTP/2 then HTTP/1.1.
fn self_signed_tls_config() -> Result<rustls::ServerConfig> {
    // Install the ring crypto provider once (ignored if already set).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cert = rcgen::generate_simple_self_signed(vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ])
    .context("generating self-signed certificate")?;
    let cert_der = cert.cert.der().clone();
    let key_der = rustls::pki_types::PrivateKeyDer::Pkcs8(cert.key_pair.serialize_der().into());

    let mut config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert_der], key_der)
        .context("loading self-signed certificate")?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(config)
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
