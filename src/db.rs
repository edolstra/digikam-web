use std::cmp::Ordering;
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
    /// Writable pool for our own `web.sql` (bookmarks), if it could be opened.
    pub web: Option<Pool>,
    pub roots: Arc<HashMap<i64, AlbumRoot>>,
    /// Whether `--allow-writes` was given: `pool` is then writable and the write
    /// endpoints (e.g. `PATCH /api/photos/:id`) work; otherwise they return 403.
    pub allow_writes: bool,
}

/// Natural ("version") comparison of two strings, used as the SQLite `NATURAL`
/// collation for the `name` sort. Maximal runs of ASCII digits compare by numeric
/// value (so `9_foo` sorts before `10_bar`); everything else compares
/// case-insensitively (ASCII, like SQLite's built-in `NOCASE`). Separators such as
/// `_`, `-`, and spaces fall into the non-digit runs and compare lexicographically.
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.as_bytes(), b.as_bytes());
    loop {
        match (a.first(), b.first()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(&ca), Some(&cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let (na, nb) = (digit_run(a), digit_run(b));
                    match cmp_numeric(&a[..na], &b[..nb]) {
                        Ordering::Equal => {
                            a = &a[na..];
                            b = &b[nb..];
                        }
                        other => return other,
                    }
                } else {
                    match ca.to_ascii_lowercase().cmp(&cb.to_ascii_lowercase()) {
                        Ordering::Equal => {
                            a = &a[1..];
                            b = &b[1..];
                        }
                        other => return other,
                    }
                }
            }
        }
    }
}

/// Length of the leading run of ASCII digits in `s`.
fn digit_run(s: &[u8]) -> usize {
    s.iter().take_while(|c| c.is_ascii_digit()).count()
}

/// Compare two ASCII-digit runs by numeric value, overflow-proof (no parsing):
/// drop leading zeros, then the longer run is the larger number; equal lengths
/// compare byte-wise. A final tie-break on the raw length keeps e.g. `9` before
/// `09` deterministic (rather than relying on the row-id tiebreak).
fn cmp_numeric(a: &[u8], b: &[u8]) -> Ordering {
    let (sa, sb) = (strip_zeros(a), strip_zeros(b));
    sa.len()
        .cmp(&sb.len())
        .then_with(|| sa.cmp(sb))
        .then_with(|| a.len().cmp(&b.len()))
}

/// Drop leading `0` bytes, but keep at least one digit (all-zeros → `"0"`).
fn strip_zeros(s: &[u8]) -> &[u8] {
    let nz = s.iter().take_while(|&&c| c == b'0').count();
    &s[nz.min(s.len() - 1)..]
}

/// Open a connection pool to the Digikam database.
///
/// By default (`writable == false`) connections are opened with
/// `SQLITE_OPEN_READ_ONLY` **and** `PRAGMA query_only`, so we can never modify
/// Digikam's data. With `--allow-writes` the main pool is opened
/// `SQLITE_OPEN_READ_WRITE` instead (never CREATE — the DB must already exist)
/// so the write endpoints can update it. Each connection sets a busy timeout so
/// that our reads/writes don't fail while Digikam itself is writing.
pub fn build_pool(database: &Path, trace_sql: bool, writable: bool) -> Result<Pool> {
    if !database.exists() {
        anyhow::bail!("database not found: {}", database.display());
    }
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let manager = SqliteConnectionManager::file(database)
        .with_flags(flags)
        .with_init(move |c| {
            c.busy_timeout(std::time::Duration::from_secs(5))?;
            if !writable {
                c.pragma_update(None, "query_only", true)?;
            }
            // Natural ("version") ordering for the `name` sort (see `natural_cmp`).
            // Named `NATSORT` (not `NATURAL`, which is a reserved SQL keyword and
            // can't appear bare after `COLLATE`). Registering a collation doesn't
            // write to the DB, so it's fine on a read-only / `query_only` connection.
            c.create_collation("NATSORT", natural_cmp)?;
            if trace_sql {
                // The callback receives each statement with its bound values
                // already expanded, logged under the `digikam_web::sql` target.
                c.trace(Some(|sql| {
                    tracing::info!(target: "digikam_web::sql", "{sql}");
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

/// Open (creating if missing) a **writable** pool for our own `web.sql` and run
/// the bookmarks migration.
///
/// Unlike the Digikam pool — writable only with the opt-in `--allow-writes` —
/// `web.sql` is *our* data file (never a Digikam DB), so it's always opened with
/// `SQLITE_OPEN_READ_WRITE | SQLITE_OPEN_CREATE` and **without** `query_only`.
pub fn build_web_pool(database: &Path, trace_sql: bool) -> Result<Pool> {
    let manager = SqliteConnectionManager::file(database)
        .with_flags(OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE)
        .with_init(move |c| {
            c.busy_timeout(std::time::Duration::from_secs(5))?;
            if trace_sql {
                c.trace(Some(|sql| {
                    tracing::info!(target: "digikam_web::sql", "{sql}");
                }));
            }
            Ok(())
        });
    let pool = r2d2::Pool::builder()
        .max_size(4)
        .build(manager)
        .context("failed to open bookmarks database pool")?;

    pool.get()
        .context("failed to get bookmarks connection")?
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS bookmarks ( \
               name       TEXT PRIMARY KEY, \
               album      TEXT    NOT NULL, \
               recursive  INTEGER NOT NULL, \
               min_rating INTEGER NOT NULL, \
               images     INTEGER NOT NULL, \
               video      INTEGER NOT NULL, \
               aspect     TEXT    NOT NULL, \
               tags       TEXT    NOT NULL DEFAULT '[]', \
               sort       TEXT    NOT NULL DEFAULT 'modified' \
             )",
        )
        .context("failed to create bookmarks table")?;

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
    fn natural_ordering() {
        use std::cmp::Ordering::*;
        // The motivating case: numeric runs compare by value, not lexically.
        assert_eq!(natural_cmp("9_foo", "10_bar"), Less);
        assert_eq!(natural_cmp("10_bar", "9_foo"), Greater);
        assert_eq!(natural_cmp("img2.jpg", "img10.jpg"), Less);
        // Case-insensitive, like NOCASE.
        assert_eq!(natural_cmp("Foo", "foo"), Equal);
        assert_eq!(natural_cmp("ABC", "abd"), Less);
        // Leading zeros don't change the value; same value tie-breaks deterministically.
        assert_eq!(natural_cmp("09_a", "9_a"), Greater); // "9" before "09"
        assert_eq!(natural_cmp("file007", "file7"), Greater);
        // Big numbers beyond u64 still compare correctly (no parsing/overflow).
        assert_eq!(
            natural_cmp("v99999999999999999999", "v100000000000000000000"),
            Less
        );
        // Separators are ordinary non-digit characters.
        assert_eq!(natural_cmp("a-2", "a-10"), Less);
        // Sorting a slice gives the expected natural order.
        let mut v = ["10_b", "9_a", "1_c", "100_d"];
        v.sort_by(|x, y| natural_cmp(x, y));
        assert_eq!(v, ["1_c", "9_a", "10_b", "100_d"]);
    }

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
