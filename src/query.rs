use std::collections::HashMap;

use rusqlite::types::Value;
use rusqlite::Connection;

use crate::db::{album_display_path, AlbumRoot};
use crate::error::{AppError, AppResult};
use crate::models::{Page, PhotoSummary};

pub const DEFAULT_LIMIT: i64 = 200;
pub const MAX_LIMIT: i64 = 1000;

/// Parsed query parameters for `GET /photos`.
#[derive(Debug, Default)]
pub struct PhotoQuery {
    /// `/Root/relative/path`. `None` means no album filter.
    pub album: Option<String>,
    /// When true, the album filter also matches sub-albums; otherwise only the
    /// named album itself. Has no effect without `album`.
    pub recursive: bool,
    /// Tag names; an image must carry every one of them (exact match).
    pub tags: Vec<String>,
    pub limit: i64,
    pub offset: i64,
}

/// Escape `%`, `_` and `\` for use in a `LIKE ... ESCAPE '\'` pattern.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Resolve a tag name to the id(s) of tags with exactly that name.
///
/// A name may be shared by several tags under different parents; all of them
/// are returned and treated as alternatives for that name.
fn resolve_tag_ids(conn: &Connection, name: &str) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare_cached("SELECT id FROM Tags WHERE name = ?1")?;
    let ids = stmt
        .query_map([name], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// Build the shared `FROM ... WHERE ...` fragment plus its bound parameters.
fn build_filter(conn: &Connection, q: &PhotoQuery) -> AppResult<(String, Vec<Value>)> {
    let mut sql = String::from(
        " FROM Images i \
          JOIN Albums a ON a.id = i.album \
          JOIN AlbumRoots r ON r.id = a.albumRoot \
          LEFT JOIN ImageInformation ii ON ii.imageid = i.id \
          WHERE i.status = 1",
    );
    let mut params: Vec<Value> = Vec::new();

    if let Some(album) = &q.album {
        let trimmed = album.trim_start_matches('/');
        if trimmed.is_empty() {
            return Err(AppError::BadRequest(
                "album must be of the form /Root or /Root/relative/path".into(),
            ));
        }
        let (label, rest) = match trimmed.split_once('/') {
            Some((l, r)) => (l, r),
            None => (trimmed, ""),
        };
        sql.push_str(" AND r.label = ?");
        params.push(Value::Text(label.to_string()));

        // Digikam stores relativePath with a leading slash and no trailing
        // slash; the root album of a collection is "/".
        let rel = if rest.is_empty() {
            "/".to_string()
        } else {
            format!("/{rest}")
        };

        if q.recursive {
            if rest.is_empty() {
                // The whole collection: every album under this root.
            } else {
                let like = format!("{}/%", escape_like(&rel));
                sql.push_str(" AND (a.relativePath = ? OR a.relativePath LIKE ? ESCAPE '\\')");
                params.push(Value::Text(rel));
                params.push(Value::Text(like));
            }
        } else {
            // Only photos directly in the named album.
            sql.push_str(" AND a.relativePath = ?");
            params.push(Value::Text(rel));
        }
    }

    for name in &q.tags {
        let ids = resolve_tag_ids(conn, name)?;
        if ids.is_empty() {
            // Unknown tag: no image can satisfy the AND, so force an empty result.
            sql.push_str(" AND 1 = 0");
            continue;
        }
        let placeholders = std::iter::repeat("?")
            .take(ids.len())
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM ImageTags it WHERE it.imageid = i.id AND it.tagid IN ({placeholders}))"
        ));
        params.extend(ids.into_iter().map(Value::Integer));
    }

    Ok((sql, params))
}

/// Map a non-negative integer column to `Option<u64>`, treating negatives as absent.
fn opt_u64(v: Option<i64>) -> Option<u64> {
    v.and_then(|n| u64::try_from(n).ok())
}

/// Execute the photo listing query.
pub fn list_photos(
    conn: &Connection,
    roots: &HashMap<i64, AlbumRoot>,
    q: &PhotoQuery,
) -> AppResult<Page<PhotoSummary>> {
    let (filter, params) = build_filter(conn, q)?;

    // Total count over the same filter.
    let count_sql = format!("SELECT COUNT(*){filter}");
    let total: i64 = conn.query_row(
        &count_sql,
        rusqlite::params_from_iter(params.iter()),
        |row| row.get(0),
    )?;

    // Page of results, newest first.
    let select_sql = format!(
        "SELECT i.id, i.name, a.albumRoot, a.relativePath, i.fileSize, \
                ii.format, ii.width, ii.height, ii.rating, ii.creationDate{filter} \
         ORDER BY ii.creationDate DESC, i.id DESC \
         LIMIT ? OFFSET ?"
    );
    let mut select_params = params;
    select_params.push(Value::Integer(q.limit));
    select_params.push(Value::Integer(q.offset));

    let mut stmt = conn.prepare(&select_sql)?;
    let items = stmt
        .query_map(rusqlite::params_from_iter(select_params.iter()), |row| {
            let album_root: i64 = row.get(2)?;
            let relative_path: String = row.get(3)?;
            let album_path = roots
                .get(&album_root)
                .map(|r| album_display_path(r, &relative_path))
                .unwrap_or_else(|| relative_path.clone());
            Ok(PhotoSummary {
                id: row.get::<_, i64>(0)? as u64,
                name: row.get(1)?,
                album_path,
                file_size: opt_u64(row.get(4)?),
                format: row.get(5)?,
                width: opt_u64(row.get(6)?),
                height: opt_u64(row.get(7)?),
                rating: opt_u64(row.get(8)?),
                creation_date: row.get(9)?,
                mime: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Fill in MIME types from the file name extension.
    let items = items
        .into_iter()
        .map(|mut p| {
            p.mime = mime_guess::from_path(&p.name)
                .first()
                .map(|m| m.essence_str().to_string());
            p
        })
        .collect();

    Ok(Page {
        total,
        limit: q.limit,
        offset: q.offset,
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_metacharacters() {
        assert_eq!(escape_like("/a_b%c\\d"), "/a\\_b\\%c\\\\d");
    }
}
