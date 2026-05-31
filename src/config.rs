use std::net::SocketAddr;
use std::path::PathBuf;

use clap::Parser;

/// Read-only web backend for browsing a Digikam photo database.
#[derive(Debug, Clone, Parser)]
#[command(name = "digikam-browse", version, about)]
pub struct Config {
    /// Path to the Digikam SQLite database (digikam4.db).
    #[arg(
        long,
        env = "DIGIKAM_DB",
        default_value_os_t = default_db_path(),
    )]
    pub database: PathBuf,

    /// Path to the Digikam thumbnails DB (thumbnails-digikam.db). Defaults to a
    /// `thumbnails-digikam.db` next to `--database`. If absent, the thumbnail
    /// endpoint returns 404.
    #[arg(long, env = "THUMBNAIL_DB")]
    pub thumbnail_database: Option<PathBuf>,

    /// Address to listen on.
    #[arg(long, env = "LISTEN_ADDR", default_value = "127.0.0.1:8080")]
    pub listen: SocketAddr,

    /// Log every SQL statement (with bound values) as it executes.
    #[arg(long, env = "TRACE_SQL")]
    pub trace_sql: bool,
}

impl Config {
    /// The thumbnails DB path: the `--thumbnail-database` override, else a
    /// `thumbnails-digikam.db` alongside `--database`.
    pub fn thumbnail_db_path(&self) -> PathBuf {
        self.thumbnail_database.clone().unwrap_or_else(|| {
            self.database
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("thumbnails-digikam.db")
        })
    }
}

/// The conventional location of the Digikam database under the user's home dir.
fn default_db_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match home {
        Some(h) => h.join(".local/share/digikam/db/digikam4.db"),
        None => PathBuf::from("digikam4.db"),
    }
}
