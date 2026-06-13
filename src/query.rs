use std::collections::HashMap;
use std::fmt;

use rusqlite::types::Value;
use rusqlite::Connection;
use serde::de::{self, Deserialize, Deserializer};
use serde::{Serialize, Serializer};

use crate::db::{album_display_path, AlbumRoot};
use crate::error::AppResult;
use crate::models::{Cover, Filters, Page, PhotoSummary, SubAlbum};

pub const DEFAULT_LIMIT: u64 = 25000;
pub const MAX_LIMIT: u64 = 100000;

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

impl Serialize for Rating {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_i64(self.0)
    }
}

impl<'de> Deserialize<'de> for Rating {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = i64::deserialize(d)?;
        Rating::new(value).ok_or_else(|| de::Error::custom("min_rating must be between 0 and 5"))
    }
}

/// The aspect-ratio filter. `Portrait` is `height >= width`, `Landscape` is
/// `width >= height`, so a square matches both. Modeled as an enum (rather than
/// two booleans) so it can grow to exact ratios (e.g. 16:9) later. The default,
/// `All`, applies no constraint.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Aspect {
    #[default]
    All,
    Portrait,
    Landscape,
}

impl Aspect {
    /// The SQL `AND` fragment restricting `ImageInformation` dimensions. Items
    /// with a NULL width/height make the comparison NULL → excluded from
    /// portrait/landscape, but kept under `All` (no clause).
    pub fn sql_filter(self) -> &'static str {
        match self {
            Aspect::All => "",
            Aspect::Portrait => " AND ii.height >= ii.width",
            Aspect::Landscape => " AND ii.width >= ii.height",
        }
    }

    /// The canonical string form (matches the query-string / JSON values).
    pub fn as_str(self) -> &'static str {
        match self {
            Aspect::All => "all",
            Aspect::Portrait => "portrait",
            Aspect::Landscape => "landscape",
        }
    }

    /// Parse the canonical string form, e.g. when reading a stored bookmark.
    pub fn parse(s: &str) -> Option<Aspect> {
        match s {
            "all" => Some(Aspect::All),
            "portrait" => Some(Aspect::Portrait),
            "landscape" => Some(Aspect::Landscape),
            _ => None,
        }
    }
}

impl Serialize for Aspect {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Aspect {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Aspect::parse(&String::deserialize(d)?)
            .ok_or_else(|| de::Error::custom("aspect must be all, portrait, or landscape"))
    }
}

/// Parsed query parameters for `GET /photos`: an album scope plus the view
/// [`Filters`] (shared with `/subalbums` and bookmarks) and paging.
#[derive(Debug, Default)]
pub struct PhotoQuery {
    /// Album path as segments (`["Photos", "Lego"]` for `/Photos/Lego`); empty
    /// means no album filter. The first segment is the `AlbumRoots.label`.
    pub album: Vec<String>,
    /// When true, the album filter also matches sub-albums; otherwise only the
    /// named album itself. Has no effect without `album`. (Not a [`Filters`]
    /// field — `/subalbums` ignores it.)
    pub recursive: bool,
    /// The view filters (rating / media / aspect / tags). `Filters::default()`
    /// includes everything (both media types on, no rating/aspect/tag filter).
    pub filters: Filters,
    pub limit: u64,
    pub offset: u64,
}

/// The SQL `AND` fragment restricting `Images.category` for the media-type
/// filter. Videos are `category = 2`; anything else is treated as an image.
/// Both booleans true → no restriction; both false → match nothing.
pub fn media_filter_sql(include_images: bool, include_video: bool) -> &'static str {
    match (include_images, include_video) {
        (true, true) => "",
        (true, false) => " AND i.category != 2",
        (false, true) => " AND i.category = 2",
        (false, false) => " AND 1 = 0",
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

/// A SQL subquery yielding the tag ids one tag-filter token matches — the
/// matched tag(s) **plus all their descendants**. No substring matching.
///
/// - A token starting with `/` is an **absolute path** (`/local/fashion`): it
///   matches the single tag at that path (built by walking `pid` from the root).
/// - Any other token is a **name**: it matches every tag with exactly that name,
///   at any level.
///
/// Descendants come from `TagsTree` (the ancestor closure: `pid = T` lists T's
/// descendants). Returned for inlining into an `IN (...)` (an unmatched token
/// yields no rows, so the `EXISTS` simply fails). The token is user input, so it
/// goes in as an escaped SQL string literal (doubled quotes) — not a bound param,
/// so the one fragment splices into both the positional `build_filter` and the
/// named-param `list_subalbums` without a second query.
fn resolve_tag_filter(token: &str) -> String {
    // Escape for a single-quoted SQLite string literal (`'` -> `''`).
    let lit = format!("'{}'", token.trim_end_matches('/').replace('\'', "''"));
    if token.starts_with('/') {
        format!(
            "WITH RECURSIVE paths(id, path) AS ( \
               SELECT id, '/' || name FROM Tags WHERE pid = 0 \
               UNION ALL \
               SELECT t.id, p.path || '/' || t.name FROM Tags t JOIN paths p ON t.pid = p.id \
             ), base(id) AS (SELECT id FROM paths WHERE path = {lit}) \
             SELECT id FROM base \
             UNION SELECT id FROM TagsTree WHERE pid IN (SELECT id FROM base)"
        )
    } else {
        format!(
            "WITH base(id) AS (SELECT id FROM Tags WHERE name = {lit}) \
             SELECT id FROM base \
             UNION SELECT id FROM TagsTree WHERE pid IN (SELECT id FROM base)"
        )
    }
}

/// Build the `AND EXISTS (...)` SQL for a tag-filter token list (AND'd: a photo
/// must match every token). The image table must be aliased `i`. Each token's
/// matching ids resolve inline via [`resolve_tag_filter`], so this adds no bound
/// params and runs as part of the single main query (no per-token round-trips).
fn tag_filter_sql(tokens: &[String]) -> String {
    let mut sql = String::new();
    for token in tokens {
        let ids = resolve_tag_filter(token);
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM ImageTags it WHERE it.imageid = i.id AND it.tagid IN ({ids}))"
        ));
    }
    sql
}

/// Split a display path (`/Photos/Lego`) into album segments (`["Photos",
/// "Lego"]`); an empty/`"/"` path yields `[]` (the virtual root).
pub fn album_segments(path: &str) -> Vec<String> {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Split album segments into the root `label` and the album's `relativePath`
/// (`None` for a collection's root album, else `Some("/seg/seg")`). Returns
/// `None` when there are no segments (the virtual root).
fn album_root_and_rel(album: &[String]) -> Option<(&str, Option<String>)> {
    let (label, rest) = album.split_first()?;
    let rel = (!rest.is_empty()).then(|| format!("/{}", rest.join("/")));
    Some((label.as_str(), rel))
}

/// Build the shared `FROM ... WHERE ...` fragment plus its bound parameters.
fn build_filter(q: &PhotoQuery) -> (String, Vec<Value>) {
    let mut sql = String::from(
        " FROM Images i \
          JOIN Albums a ON a.id = i.album \
          JOIN AlbumRoots r ON r.id = a.albumRoot \
          LEFT JOIN ImageInformation ii ON ii.imageid = i.id \
          WHERE i.status = 1",
    );
    let mut params: Vec<Value> = Vec::new();

    if let Some((label, rel)) = album_root_and_rel(&q.album) {
        sql.push_str(" AND r.label = ?");
        params.push(Value::Text(label.to_string()));

        if q.recursive {
            // The named album plus every album beneath it. (A root album — `rel`
            // is `None` — recursively is the whole collection, so no constraint.)
            if let Some(rel) = rel {
                let like = format!("{}/%", escape_like(&rel));
                sql.push_str(" AND (a.relativePath = ? OR a.relativePath LIKE ? ESCAPE '\\')");
                params.push(Value::Text(rel));
                params.push(Value::Text(like));
            }
        } else {
            // Only photos directly in the named album (the root album is "/").
            sql.push_str(" AND a.relativePath = ?");
            params.push(Value::Text(rel.unwrap_or_else(|| "/".to_string())));
        }
    }

    sql.push_str(&tag_filter_sql(&q.filters.tags));

    if q.filters.min_rating.get() > 0 {
        // Treat unrated images (rating -1, or NULL when there's no
        // ImageInformation row) as rating 0, so the threshold excludes them.
        sql.push_str(" AND max(ifnull(ii.rating, 0), 0) >= ?");
        params.push(Value::Integer(q.filters.min_rating.get()));
    }

    // Media-type and aspect-ratio filters (constant fragments, no bound params).
    sql.push_str(media_filter_sql(
        q.filters.include_images,
        q.filters.include_video,
    ));
    sql.push_str(q.filters.aspect.sql_filter());

    (sql, params)
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
    // The virtual root (no album segments) has no photos of its own; an empty,
    // non-recursive album is simply empty. (A future recursive flag would
    // aggregate the whole collection from the root.)
    if q.album.is_empty() && !q.recursive {
        return Ok(Page {
            incomplete: false,
            limit: q.limit,
            offset: q.offset,
            items: Vec::new(),
        });
    }

    let (filter, params) = build_filter(q);

    // Page of results, newest first.
    let select_sql = format!(
        "SELECT i.id, i.name, a.albumRoot, a.relativePath, i.fileSize, \
                ii.format, ii.width, ii.height, ii.rating, i.modificationDate, i.category{filter} \
         ORDER BY i.modificationDate DESC, i.id DESC \
         LIMIT ? OFFSET ?"
    );
    let mut select_params = params;
    // Fetch one row past the limit to detect whether more results exist.
    // `saturating_add` keeps `u64::MAX` (the "list everything" sentinel) at -1,
    // which SQLite treats as no limit (rather than overflowing to LIMIT 0).
    select_params.push(Value::Integer(q.limit.saturating_add(1) as i64));
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
                modification_date: row.get(9)?,
                mime: None,
                is_video: row.get::<_, i64>(10)? == 2,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Fill in MIME types from the file name extension.
    let mut items: Vec<PhotoSummary> = items
        .into_iter()
        .map(|mut p| {
            p.mime = mime_guess::from_path(&p.name)
                .first()
                .map(|m| m.essence_str().to_string());
            p
        })
        .collect();

    // If the extra row came back, there are more results beyond this page: drop
    // it and flag the page incomplete.
    let incomplete = items.len() as u64 > q.limit;
    if incomplete {
        items.truncate(q.limit as usize);
    }

    Ok(Page {
        incomplete,
        limit: q.limit,
        offset: q.offset,
        items,
    })
}

/// List the direct sub-albums of `album`, each with its recursive photo count
/// and a cover (the newest **image** anywhere in that sub-album's subtree), sorted
/// by most recent photo (newest first; ties broken by name). Sub-albums with no
/// matching photos anywhere are omitted.
///
/// An **empty** `album` lists the album roots themselves (as if they were
/// sub-albums of a virtual top level), bucketed by root label rather than by
/// child path segment.
///
/// `filters` applies the same filtering as the photo grid to the whole subtree,
/// so the count, the cover, and which sub-albums appear all respect it.
///
/// Videos (`category = 2`) are never used as a cover: a sub-album whose subtree
/// contains only (matching) videos is still listed but with no cover (`cover` is
/// `None`). The photo count includes videos.
///
/// One query: every matching photo is tagged with a `bucket` (the child path
/// segment, or the root label at the top level); the count is taken over all
/// photos in the bucket, while the cover is the newest non-video photo
/// (left-joined, so it may be absent).
pub fn list_subalbums(
    conn: &Connection,
    roots: &HashMap<i64, AlbumRoot>,
    album: &[String],
    filters: &Filters,
) -> AppResult<Vec<SubAlbum>> {
    // 0 makes the rating clause `max(...,0) >= 0` always true (i.e. no filter).
    let min = filters.min_rating.get();
    // Constant media-type + aspect fragments, appended to each `matched` WHERE so
    // the sub-album counts, covers, and visibility all respect the filters.
    let media = media_filter_sql(filters.include_images, filters.include_video);
    let aspect = filters.aspect.sql_filter();
    // Tag filter (AND of `EXISTS` clauses, ids inlined); image alias is `i` below.
    let tags = tag_filter_sql(&filters.tags);
    // Display path of `album`, used to build each child's `path` ("" at the root).
    let parent = if album.is_empty() {
        String::new()
    } else {
        format!("/{}", album.join("/"))
    };

    // Each mode produces the `matched` rows (image_id, image_name, category,
    // cdate, bucket); only the bucketing/scope differs.
    let (matched, params): (String, Vec<(&str, Value)>) = match album_root_and_rel(album) {
        // Virtual top level: one bucket per album root (its label).
        None => (
            format!(
                "SELECT i.id AS image_id, i.name AS image_name, i.category AS category, \
                        i.modificationDate AS cdate, r.label AS bucket \
                 FROM Images i JOIN Albums a ON a.id = i.album \
                 JOIN AlbumRoots r ON r.id = a.albumRoot \
                 LEFT JOIN ImageInformation ii ON ii.imageid = i.id \
                 WHERE i.status = 1 AND max(ifnull(ii.rating, 0), 0) >= :min{media}{aspect}{tags}"
            ),
            vec![(":min", Value::Integer(min))],
        ),
        Some((label, rel)) => {
            let Some((&root_id, _)) = roots.iter().find(|(_, r)| r.label == label) else {
                return Ok(Vec::new());
            };
            // Path prefix shared by every album in the subtree (root album is "/").
            let prefix = match rel {
                None => "/".to_string(),
                Some(rel) => format!("{rel}/"),
            };
            let like = format!("{}%", escape_like(&prefix));
            // Bucket each subtree photo by its direct-child path segment (the part
            // of the relativePath after the prefix, up to the next '/'). Filtering
            // by `albumRoot` id lets the `(albumRoot, relativePath)` index serve it.
            (
                format!(
                    "SELECT image_id, image_name, category, cdate, \
                            CASE WHEN instr(rest, '/') > 0 \
                                 THEN substr(rest, 1, instr(rest, '/') - 1) ELSE rest END AS bucket \
                     FROM ( \
                       SELECT i.id AS image_id, i.name AS image_name, i.category AS category, \
                              i.modificationDate AS cdate, \
                              substr(a.relativePath, length(:prefix) + 1) AS rest \
                       FROM Images i JOIN Albums a ON a.id = i.album \
                       LEFT JOIN ImageInformation ii ON ii.imageid = i.id \
                       WHERE i.status = 1 AND a.albumRoot = :root \
                         AND a.relativePath LIKE :like ESCAPE '\\' \
                         AND length(a.relativePath) > length(:prefix) \
                         AND max(ifnull(ii.rating, 0), 0) >= :min{media}{aspect}{tags} \
                     )"
                ),
                vec![
                    (":prefix", Value::Text(prefix)),
                    (":root", Value::Integer(root_id)),
                    (":like", Value::Text(like)),
                    (":min", Value::Integer(min)),
                ],
            )
        }
    };

    // Shared: group the matched rows into one tile per bucket (count + newest
    // cover), newest bucket first. The cover is the newest item — image OR video
    // (videos have stored thumbnails the client renders), so its `category` rides
    // along to flag a video cover.
    let sql = format!(
        "WITH matched AS ( {matched} ), \
         counts AS ( \
           SELECT bucket, COUNT(*) AS cnt, max(cdate) AS recent FROM matched GROUP BY bucket \
         ), \
         covers AS ( \
           SELECT bucket, image_id, image_name, category, \
                  ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY cdate DESC, image_id DESC) AS rn \
           FROM matched \
         ) \
         SELECT c.bucket, cv.image_id, cv.image_name, cv.category, c.cnt \
         FROM counts c LEFT JOIN covers cv ON cv.bucket = c.bucket AND cv.rn = 1 \
         ORDER BY c.recent DESC, c.bucket COLLATE NOCASE"
    );

    let bound: Vec<(&str, &dyn rusqlite::ToSql)> = params
        .iter()
        .map(|(n, v)| (*n, v as &dyn rusqlite::ToSql))
        .collect();
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(&bound[..], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<i64>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (bucket, image_id, image_name, category, cnt) = row?;
        // Every non-empty bucket now has a cover (image or video).
        let cover = match (image_id, image_name) {
            (Some(id), Some(name)) => Some(Cover {
                id: id as u64,
                name,
                is_video: category == Some(2),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_metacharacters() {
        assert_eq!(escape_like("/a_b%c\\d"), "/a\\_b\\%c\\\\d");
    }

    #[test]
    fn splits_album_segments() {
        assert_eq!(album_segments("/Photos/Lego"), ["Photos", "Lego"]);
        assert_eq!(album_segments("/Photos"), ["Photos"]);
        assert!(album_segments("/").is_empty());
        assert!(album_segments("").is_empty());
    }

    #[test]
    fn splits_root_and_rel() {
        assert_eq!(album_root_and_rel(&[]), None);
        assert_eq!(
            album_root_and_rel(&["Photos".to_string()]),
            Some(("Photos", None))
        );
        assert_eq!(
            album_root_and_rel(&["Photos".to_string(), "Lego".to_string(), "X".to_string()]),
            Some(("Photos", Some("/Lego/X".to_string())))
        );
    }

    #[test]
    fn media_filter_fragments() {
        assert_eq!(media_filter_sql(true, true), ""); // all media
        assert_eq!(media_filter_sql(true, false), " AND i.category != 2"); // images only
        assert_eq!(media_filter_sql(false, true), " AND i.category = 2"); // video only
        assert_eq!(media_filter_sql(false, false), " AND 1 = 0"); // neither
    }

    #[test]
    fn aspect_filter_fragments() {
        assert_eq!(Aspect::All.sql_filter(), "");
        // Inclusive >= on both sides, so a square matches portrait and landscape.
        assert_eq!(Aspect::Portrait.sql_filter(), " AND ii.height >= ii.width");
        assert_eq!(Aspect::Landscape.sql_filter(), " AND ii.width >= ii.height");
    }
}
