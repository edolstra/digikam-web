use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::OpenFlags;

pub type Pool = r2d2::Pool<SqliteConnectionManager>;
pub type PooledConn = r2d2::PooledConnection<SqliteConnectionManager>;

/// Information about a single Digikam album root.
#[derive(Debug, Clone)]
pub struct AlbumRoot {
    pub label: String,
    /// Absolute base directory on disk, e.g. `/home/eelco/Images/Photos`.
    pub base: PathBuf,
}

/// Shared application state handed to every request handler.
#[derive(Clone)]
pub struct AppState {
    pub pool: Pool,
    /// Read-only pool for Digikam's `thumbnails-digikam.db`, if it was found.
    pub thumbs: Option<Pool>,
    pub roots: Arc<HashMap<i64, AlbumRoot>>,
}

/// Open a read-only connection pool to the Digikam database.
///
/// Connections are opened with `SQLITE_OPEN_READ_ONLY` so we can never modify
/// Digikam's data, and each sets a busy timeout so that reads don't fail while
/// Digikam itself is writing.
pub fn build_pool(database: &Path, trace_sql: bool) -> Result<Pool> {
    if !database.exists() {
        anyhow::bail!("database not found: {}", database.display());
    }
    let manager = SqliteConnectionManager::file(database)
        .with_flags(OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_init(move |c| {
            c.busy_timeout(std::time::Duration::from_secs(5))?;
            c.pragma_update(None, "query_only", true)?;
            if trace_sql {
                // The callback receives each statement with its bound values
                // already expanded, logged under the `digikam_browse::sql` target.
                c.trace(Some(|sql| {
                    tracing::info!(target: "digikam_browse::sql", "{sql}");
                }));
            }
            Ok(())
        });
    let pool = r2d2::Pool::builder()
        .max_size(8)
        .build(manager)
        .context("failed to open database pool")?;
    Ok(pool)
}

/// Load the album roots and resolve each to its absolute base directory.
///
/// `AlbumRoots.identifier` looks like
/// `volumeid:?path=/home/eelco/Images/Photos&fileuuid=...`; we extract the
/// `path=` query parameter and join it with `specificPath`.
pub fn load_roots(conn: &PooledConn) -> Result<HashMap<i64, AlbumRoot>> {
    let mut stmt = conn.prepare("SELECT id, label, identifier, specificPath FROM AlbumRoots")?;
    let rows = stmt.query_map([], |row| {
        let id: i64 = row.get(0)?;
        let label: Option<String> = row.get(1)?;
        let identifier: Option<String> = row.get(2)?;
        let specific_path: Option<String> = row.get(3)?;
        Ok((id, label, identifier, specific_path))
    })?;

    let mut roots = HashMap::new();
    for row in rows {
        let (id, label, identifier, specific_path) = row?;
        let identifier = identifier.unwrap_or_default();
        let Some(base_path) = parse_volume_path(&identifier) else {
            tracing::warn!(root = id, %identifier, "skipping album root with unparseable identifier");
            continue;
        };
        let mut base = PathBuf::from(base_path);
        // specificPath is "/" for a root located at the volume's mount point.
        if let Some(sp) = specific_path {
            let sp = sp.trim_start_matches('/');
            if !sp.is_empty() {
                base.push(sp);
            }
        }
        roots.insert(
            id,
            AlbumRoot {
                label: label.unwrap_or_else(|| format!("root{id}")),
                base,
            },
        );
    }
    Ok(roots)
}

/// Extract the base directory from a Digikam album-root identifier, percent-decoding
/// it. Local volumes use `volumeid:?path=/abs/dir&fileuuid=...`; network shares use
/// `networkshareid:?mountpath=/mnt/dir&fileuuid=...`. We accept either `path=` or
/// `mountpath=`.
fn parse_volume_path(identifier: &str) -> Option<String> {
    let query = identifier.split_once('?').map(|(_, q)| q)?;
    for pair in query.split('&') {
        if let Some(value) = pair
            .strip_prefix("path=")
            .or_else(|| pair.strip_prefix("mountpath="))
        {
            return Some(urlencoding::decode(value).ok()?.into_owned());
        }
    }
    None
}

/// Build the absolute file path for an image given its album root, the album's
/// `relativePath`, and the file name. The root album has `relativePath == "/"`.
pub fn image_abs_path(root: &AlbumRoot, relative_path: &str, name: &str) -> PathBuf {
    let mut p = root.base.clone();
    let rel = relative_path.trim_start_matches('/');
    if !rel.is_empty() {
        p.push(rel);
    }
    p.push(name);
    p
}

/// Build the user-facing display path for an album, e.g. `/Photos/Lego`.
pub fn album_display_path(root: &AlbumRoot, relative_path: &str) -> String {
    let rel = relative_path.trim_start_matches('/');
    if rel.is_empty() {
        format!("/{}", root.label)
    } else {
        format!("/{}/{}", root.label, rel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_volume_path() {
        let id = "volumeid:?path=/home/eelco/Images/Photos&fileuuid=478c42bb";
        assert_eq!(
            parse_volume_path(id).as_deref(),
            Some("/home/eelco/Images/Photos")
        );
        // Network shares use `networkshareid:?mountpath=...` instead of `path=`.
        let net = "networkshareid:?mountpath=/data/Video&fileuuid=082745db";
        assert_eq!(parse_volume_path(net).as_deref(), Some("/data/Video"));
    }

    #[test]
    fn builds_paths() {
        let root = AlbumRoot {
            label: "Photos".into(),
            base: PathBuf::from("/home/eelco/Images/Photos"),
        };
        assert_eq!(
            image_abs_path(&root, "/Lego/Porsche911", "img_1.jpg"),
            PathBuf::from("/home/eelco/Images/Photos/Lego/Porsche911/img_1.jpg")
        );
        assert_eq!(
            image_abs_path(&root, "/", "img_1.jpg"),
            PathBuf::from("/home/eelco/Images/Photos/img_1.jpg")
        );
        assert_eq!(album_display_path(&root, "/Lego"), "/Photos/Lego");
        assert_eq!(album_display_path(&root, "/"), "/Photos");
    }
}
