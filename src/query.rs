use std::collections::HashMap;
use std::fmt;

use rusqlite::types::Value;
use rusqlite::Connection;
use serde::de::{self, Deserialize, Deserializer};

use crate::db::{album_display_path, AlbumRoot};
use crate::error::{AppError, AppResult};
use crate::models::{Cover, Page, PhotoSummary, SubAlbum};

pub const DEFAULT_LIMIT: u64 = 200;
pub const MAX_LIMIT: u64 = 1000;

/// A photo rating constrained to 0..=5. Construction — including
/// `Deserialize` from query strings — is the single place the range is enforced,
/// so any `Rating` in hand is already valid (an out-of-range query value is
/// rejected as a `400` by the `Query` extractor). The default, `0`, means "no
/// rating filter" (unrated photos count as 0, so `>= 0` matches everything).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Rating(i64);

impl Rating {
    /// Wrap a value, returning `None` if it falls outside 0..=5.
    pub fn new(value: i64) -> Option<Rating> {
        (0..=5).contains(&value).then_some(Rating(value))
    }

    /// The underlying 0..=5 value.
    pub fn get(self) -> i64 {
        self.0
    }
}

impl fmt::Display for Rating {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl<'de> Deserialize<'de> for Rating {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = i64::deserialize(d)?;
        Rating::new(value).ok_or_else(|| de::Error::custom("min_rating must be between 0 and 5"))
    }
}

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
    /// Minimum rating; the default `Rating(0)` means no rating filter. Unrated
    /// images (rating `-1`/NULL) count as 0, so `0` includes everything and `>= 1`
    /// excludes the unrated.
    pub min_rating: Rating,
    pub limit: u64,
    pub offset: u64,
}

/// The set of view filters active on an album page. Held separately from
/// [`PhotoQuery`] so the web layer can carry them across links (see
/// [`Filters::query_string`]); consumed by [`list_subalbums`] and applied to the
/// photo grid. Designed to grow (tags, date range, …) — add a field, serialize it
/// in `query_string`, and apply it where the queries filter.
#[derive(Debug, Clone, Default)]
pub struct Filters {
    /// Minimum rating; the default `Rating(0)` means no rating filter.
    pub min_rating: Rating,
}

impl Filters {
    /// The query-string suffix encoding the active filters, e.g. `?min_rating=3`
    /// (empty when nothing is active).
    pub fn query_string(&self) -> String {
        let mut params: Vec<String> = Vec::new();
        if self.min_rating.get() > 0 {
            params.push(format!("min_rating={}", self.min_rating));
        }
        if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        }
    }

    /// A copy with `min_rating` changed, preserving any other active filters.
    // `..self.clone()` is a no-op while `min_rating` is the only field, but keeps
    // future filters (tags, …) automatically carried over.
    #[allow(clippy::needless_update)]
    pub fn with_min_rating(&self, min_rating: Rating) -> Filters {
        Filters {
            min_rating,
            ..self.clone()
        }
    }
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

/// Parse an album display path `/Root/rel...` into its root `label` and the
/// album's `relativePath` (`/` for a root album, else `/seg/seg`).
fn parse_album(album: &str) -> AppResult<(&str, String)> {
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
    let rel = if rest.is_empty() {
        // Digikam stores the root album of a collection as "/".
        "/".to_string()
    } else {
        format!("/{rest}")
    };
    Ok((label, rel))
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
        let (label, rel) = parse_album(album)?;
        sql.push_str(" AND r.label = ?");
        params.push(Value::Text(label.to_string()));

        let is_root = rel == "/";
        if q.recursive {
            if !is_root {
                // The named album plus every album beneath it.
                let like = format!("{}/%", escape_like(&rel));
                sql.push_str(" AND (a.relativePath = ? OR a.relativePath LIKE ? ESCAPE '\\')");
                params.push(Value::Text(rel));
                params.push(Value::Text(like));
            }
            // is_root + recursive: the whole collection, so no path constraint.
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
        let placeholders = vec!["?"; ids.len()].join(",");
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM ImageTags it WHERE it.imageid = i.id AND it.tagid IN ({placeholders}))"
        ));
        params.extend(ids.into_iter().map(Value::Integer));
    }

    if q.min_rating.get() > 0 {
        // Treat unrated images (rating -1, or NULL when there's no
        // ImageInformation row) as rating 0, so the threshold excludes them.
        sql.push_str(" AND max(ifnull(ii.rating, 0), 0) >= ?");
        params.push(Value::Integer(q.min_rating.get()));
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
    let total = conn.query_row(
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
    select_params.push(Value::Integer(q.limit as i64));
    select_params.push(Value::Integer(q.offset as i64));

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

/// List the direct sub-albums of `album`, each with its recursive photo count
/// and a cover (the newest **image** anywhere in that sub-album's subtree), sorted
/// by name. Albums with no matching photos anywhere are omitted.
///
/// `filters` applies the same filtering as the photo grid to the whole subtree,
/// so the count, the cover, and which sub-albums appear all respect it.
///
/// Videos (`category = 2`) are never used as a cover: a sub-album whose subtree
/// contains only (matching) videos is still listed but with no cover (`cover` is
/// `None`). The photo count includes videos.
///
/// One query: every photo in the subtree is bucketed by its direct-child path
/// segment; the count is taken over all photos in the bucket, while the cover is
/// the newest non-video photo (left-joined, so it may be absent). Filtering by
/// `albumRoot` id (resolved from `roots`) lets the `(albumRoot, relativePath)`
/// index serve the prefix range scan.
pub fn list_subalbums(
    conn: &Connection,
    roots: &HashMap<i64, AlbumRoot>,
    album: &str,
    filters: &Filters,
) -> AppResult<Vec<SubAlbum>> {
    let (label, rel) = parse_album(album)?;
    let Some((&root_id, _)) = roots.iter().find(|(_, r)| r.label == label) else {
        return Ok(Vec::new());
    };

    // Path prefix shared by every album in the subtree (the root album is "/").
    let prefix = if rel == "/" {
        "/".to_string()
    } else {
        format!("{rel}/")
    };
    let like = format!("{}%", escape_like(&prefix));
    let parent = album.trim_end_matches('/');
    // 0 makes the rating clause `max(...,0) >= 0` always true (i.e. no filter).
    let min = filters.min_rating.get();

    let mut stmt = conn.prepare_cached(
        "WITH matched AS ( \
           SELECT i.id AS image_id, i.name AS image_name, i.category AS category, \
                  ii.creationDate AS cdate, \
                  substr(a.relativePath, length(:prefix) + 1) AS rest \
           FROM Images i JOIN Albums a ON a.id = i.album \
           LEFT JOIN ImageInformation ii ON ii.imageid = i.id \
           WHERE i.status = 1 AND a.albumRoot = :root \
             AND a.relativePath LIKE :like ESCAPE '\\' \
             AND length(a.relativePath) > length(:prefix) \
             AND max(ifnull(ii.rating, 0), 0) >= :min \
         ), \
         bucketed AS ( \
           SELECT image_id, image_name, category, cdate, \
                  CASE WHEN instr(rest, '/') > 0 \
                       THEN substr(rest, 1, instr(rest, '/') - 1) \
                       ELSE rest END AS bucket \
           FROM matched \
         ), \
         counts AS ( \
           SELECT bucket, COUNT(*) AS cnt FROM bucketed GROUP BY bucket \
         ), \
         covers AS ( \
           SELECT bucket, image_id, image_name, \
                  ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY cdate DESC, image_id DESC) AS rn \
           FROM bucketed \
           WHERE category <> 2 \
         ) \
         SELECT c.bucket, cv.image_id, cv.image_name, c.cnt \
         FROM counts c \
         LEFT JOIN covers cv ON cv.bucket = c.bucket AND cv.rn = 1 \
         ORDER BY c.bucket COLLATE NOCASE",
    )?;

    let rows = stmt.query_map(
        rusqlite::named_params! { ":prefix": prefix, ":root": root_id, ":like": like, ":min": min },
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        },
    )?;

    let mut out = Vec::new();
    for row in rows {
        let (bucket, image_id, image_name, cnt) = row?;
        // A bucket with only videos has no cover image.
        let cover = match (image_id, image_name) {
            (Some(id), Some(name)) => Some(Cover {
                id: id as u64,
                name,
            }),
            _ => None,
        };
        out.push(SubAlbum {
            path: format!("{parent}/{bucket}"),
            name: bucket,
            photo_count: cnt.max(0) as u64,
            cover,
        });
    }
    Ok(out)
}

/// List the album roots as if they were sub-albums of a virtual top-level album,
/// each with a cover (newest non-video image in the whole root) and total photo
/// count, sorted by label. Mirrors [`list_subalbums`] but groups by `albumRoot`.
pub fn list_roots(conn: &Connection, roots: &HashMap<i64, AlbumRoot>) -> AppResult<Vec<SubAlbum>> {
    let mut stmt = conn.prepare_cached(
        "WITH matched AS ( \
           SELECT i.id AS image_id, i.name AS image_name, i.category AS category, \
                  ii.creationDate AS cdate, a.albumRoot AS root \
           FROM Images i JOIN Albums a ON a.id = i.album \
           LEFT JOIN ImageInformation ii ON ii.imageid = i.id \
           WHERE i.status = 1 \
         ), \
         counts AS ( \
           SELECT root, COUNT(*) AS cnt FROM matched GROUP BY root \
         ), \
         covers AS ( \
           SELECT root, image_id, image_name, \
                  ROW_NUMBER() OVER (PARTITION BY root ORDER BY cdate DESC, image_id DESC) AS rn \
           FROM matched \
           WHERE category <> 2 \
         ) \
         SELECT c.root, cv.image_id, cv.image_name, c.cnt \
         FROM counts c \
         LEFT JOIN covers cv ON cv.root = c.root AND cv.rn = 1",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, Option<i64>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (root_id, image_id, image_name, cnt) = row?;
        let Some(root) = roots.get(&root_id) else {
            continue;
        };
        let cover = match (image_id, image_name) {
            (Some(id), Some(name)) => Some(Cover {
                id: id as u64,
                name,
            }),
            _ => None,
        };
        out.push(SubAlbum {
            path: format!("/{}", root.label),
            name: root.label.clone(),
            photo_count: cnt.max(0) as u64,
            cover,
        });
    }
    // SQL groups by root id, so sort by label here (case-insensitive).
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_metacharacters() {
        assert_eq!(escape_like("/a_b%c\\d"), "/a\\_b\\%c\\\\d");
    }

    #[test]
    fn parses_album_paths() {
        assert_eq!(parse_album("/Photos").unwrap(), ("Photos", "/".to_string()));
        assert_eq!(
            parse_album("/Photos/Lego/Porsche911").unwrap(),
            ("Photos", "/Lego/Porsche911".to_string())
        );
        assert!(parse_album("/").is_err());
    }
}
