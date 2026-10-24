//! `GET /photos/:id`: a single photo's full metadata.

use axum::extract::{Path, State};
use axum::Json;
use rusqlite::OptionalExtension;

use super::{photo_not_found, run_blocking, INTERNAL_TAG_ROOT};
use crate::db::{album_display_path, image_abs_path, AppState};
use crate::error::AppResult;
use crate::models::{PhotoDetail, PhotoSummary};

/// `GET /photos/:id`
pub async fn get_photo(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<PhotoDetail>> {
    let detail = run_blocking(&state, move |conn, state| {
        let mut stmt = conn.prepare(
            "SELECT i.id, i.name, a.albumRoot, a.relativePath, i.fileSize, \
                    ii.format, ii.width, ii.height, ii.rating, i.modificationDate, \
                    p.latitudeNumber, p.longitudeNumber, i.category, ii.creationDate, \
                    (SELECT group_concat(c.comment, char(10) ORDER BY c.type, c.language, c.id) \
                       FROM ImageComments c \
                       WHERE c.imageid = i.id AND c.comment IS NOT NULL AND trim(c.comment) <> '') \
             FROM Images i \
             JOIN Albums a ON a.id = i.album \
             JOIN AlbumRoots r ON r.id = a.albumRoot \
             LEFT JOIN ImageInformation ii ON ii.imageid = i.id \
             LEFT JOIN ImagePositions p ON p.imageid = i.id \
             WHERE i.id = ?1 AND i.status = 1",
        )?;

        let row = stmt
            .query_row([id], |row| {
                let album_root: i64 = row.get(2)?;
                let relative_path: String = row.get(3)?;
                let name: String = row.get(1)?;
                let root = state.roots.get(&album_root);
                let album_path = root
                    .map(|r| album_display_path(r, &relative_path))
                    .unwrap_or_else(|| relative_path.clone());
                let file_path = root.map(|r| {
                    image_abs_path(r, &relative_path, &name)
                        .to_string_lossy()
                        .into_owned()
                });
                let mime = mime_guess::from_path(&name)
                    .first()
                    .map(|m| m.essence_str().to_string());
                Ok(PhotoDetail {
                    summary: PhotoSummary {
                        id: row.get::<_, i64>(0)? as u64,
                        name,
                        album_path,
                        file_size: opt_u64(row.get(4)?),
                        format: row.get(5)?,
                        width: opt_u64(row.get(6)?),
                        height: opt_u64(row.get(7)?),
                        rating: opt_u64(row.get(8)?),
                        modification_date: row.get(9)?,
                        creation_date: row.get(13)?,
                        mime,
                        is_video: row.get::<_, i64>(12)? == 2,
                    },
                    file_path,
                    description: row.get(14)?,
                    tags: Vec::new(),
                    latitude: row.get(10)?,
                    longitude: row.get(11)?,
                })
            })
            .optional()?
            .ok_or_else(|| photo_not_found(id))?;

        // Each tag as its absolute path (e.g. `/vacation/2020/beach`): walk up the
        // `pid` chain prepending each ancestor's name to the top-level (pid 0).
        // Excludes Digikam's internal tags (Color/Pick labels, version history).
        let mut tag_stmt = conn.prepare_cached(
            "WITH RECURSIVE paths(pid, path) AS ( \
               SELECT t.pid, t.name \
               FROM ImageTags it JOIN Tags t ON t.id = it.tagid \
               WHERE it.imageid = ?1 \
                 AND it.tagid NOT IN (SELECT id FROM TagsTree WHERE pid = ?2) \
               UNION ALL \
               SELECT par.pid, par.name || '/' || p.path \
               FROM paths p JOIN Tags par ON par.id = p.pid \
               WHERE p.pid <> 0 \
             ) \
             SELECT '/' || path FROM paths WHERE pid = 0 ORDER BY path COLLATE NOCASE",
        )?;
        let tags = tag_stmt
            .query_map([id, INTERNAL_TAG_ROOT], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(PhotoDetail { tags, ..row })
    })
    .await?;

    Ok(Json(detail))
}

/// Map a non-negative integer column to `Option<u64>`, treating negatives as absent.
fn opt_u64(v: Option<i64>) -> Option<u64> {
    v.and_then(|n| u64::try_from(n).ok())
}
