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

    /// Address to listen on.
    #[arg(long, env = "LISTEN_ADDR", default_value = "127.0.0.1:8080")]
    pub listen: SocketAddr,
}

/// The conventional location of the Digikam database under the user's home dir.
fn default_db_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match home {
        Some(h) => h.join(".local/share/digikam/db/digikam4.db"),
        None => PathBuf::from("digikam4.db"),
    }
}
