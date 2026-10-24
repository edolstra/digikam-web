//! `PATCH /photos/:id`: rating, tag, and album (file move) changes.

use std::collections::HashSet;
use std::fs;
use std::io::{self, ErrorKind};
use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use rusqlite::{OptionalExtension, TransactionBehavior};

use super::{load_image, run_blocking, INTERNAL_TAG_ROOT};
use crate::db::{image_abs_path, AppState, PooledConn};
use crate::error::{AppError, AppResult};
use crate::models::PatchPhoto;
use crate::query::Rating;

/// `PATCH /photos/:id` — partial update of a photo's Digikam metadata:
/// - `rating`: `{"rating": 3}` sets it, `{"rating": null}` clears back to
///   Digikam's "unrated" (-1), an absent field leaves it unchanged.
/// - `tags_add` / `tags_remove`: tag **ids** (from `/api/tags`) to link/unlink.
///   Already-present adds and absent removes are silent no-ops; an unknown or
///   Digikam-internal tag id is a 422 (nothing is applied — the whole patch is
///   one transaction).
/// - `album`: target album id (from `/api/albums`) — **moves** the photo: the
///   `Images.album` row and the **file on disk** (a same-filesystem move
///   only, never replacing an existing file — see [`move_no_clobber`]; cross-device is a 409, as are a name collision, a missing target
///   directory, and a source file missing on disk). The current album is a
///   silent no-op. `modificationDate`/`uniqueHash` are untouched (the move
///   keeps content and mtime), so thumbnails keep working.
///
/// `{}` is a valid no-op. Requires the server to have been started with
/// `--allow-writes` (else 403). Every actual change is logged with the image id
/// and path(s). Metadata writes touch only the DB — not the file's XMP/EXIF
/// (like Digikam with "write metadata to files" off); only a move touches disk.
pub async fn patch_photo(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(patch): Json<PatchPhoto>,
) -> AppResult<StatusCode> {
    if !state.allow_writes {
        return Err(AppError::Forbidden(
            "writes are disabled; start the server with --allow-writes".into(),
        ));
    }
    if patch.rating.is_none()
        && patch.tags_add.is_empty()
        && patch.tags_remove.is_empty()
        && patch.album.is_none()
    {
        return Ok(StatusCode::NO_CONTENT);
    }

    run_blocking(&state, move |conn, state| {
        // IMMEDIATE: take the write lock up front, waiting (busy timeout) for a
        // concurrent writer such as Digikam. A deferred transaction would read
        // first and then fail to upgrade with SQLITE_BUSY at once — SQLite skips
        // the busy handler for that upgrade, as waiting could deadlock.
        let tx = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;

        let img = load_image(conn, id)?;

        // The path is best-effort, for the change log only: fall back to the
        // album-relative path when the root is unknown.
        let path = match img.abs_path(&state.roots) {
            Ok(p) => p.to_string_lossy().into_owned(),
            Err(_) => format!("root{}:{}/{}", img.album_root, img.relative_path, img.name),
        };

        if let Some(rating) = patch.rating {
            // The current rating, for the change log (no row / NULL = unrated).
            let old: Option<i64> = conn
                .query_row(
                    "SELECT rating FROM ImageInformation WHERE imageid = ?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            let new = rating.map_or(-1, Rating::get);
            // Upsert: an image may have no ImageInformation row yet.
            conn.execute(
                "INSERT INTO ImageInformation (imageid, rating) VALUES (?1, ?2) \
                 ON CONFLICT(imageid) DO UPDATE SET rating = excluded.rating",
                rusqlite::params![id, new],
            )?;
            tracing::info!(
                id,
                path = %path,
                old = %fmt_rating(old),
                new = %fmt_rating(Some(new)),
                "rating changed"
            );
        }

        if !patch.tags_add.is_empty() || !patch.tags_remove.is_empty() {
            // The current links, so no-op adds/removes stay silent (and aren't
            // logged) and repeated ids in one request can't double-apply.
            let mut current: HashSet<i64> = conn
                .prepare("SELECT tagid FROM ImageTags WHERE imageid = ?1")?
                .query_map([id], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            for &tag in &patch.tags_add {
                let tag_path = checked_tag_path(conn, tag)?;
                if !current.insert(tag) {
                    continue;
                }
                conn.execute(
                    "INSERT INTO ImageTags (imageid, tagid) VALUES (?1, ?2)",
                    [id, tag],
                )?;
                tracing::info!(id, path = %path, tag = %tag_path, tag_id = tag, "tag added");
            }
            for &tag in &patch.tags_remove {
                let tag_path = checked_tag_path(conn, tag)?;
                if !current.remove(&tag) {
                    continue;
                }
                conn.execute(
                    "DELETE FROM ImageTags WHERE imageid = ?1 AND tagid = ?2",
                    [id, tag],
                )?;
                tracing::info!(id, path = %path, tag = %tag_path, tag_id = tag, "tag removed");
            }
        }

        // The move comes LAST: its filesystem move must sit between the final
        // DB statement and the commit — a failed move drops the transaction
        // (DB rolled back, disk untouched), a failed commit moves the file back.
        let mut moved: Option<(PathBuf, PathBuf)> = None;
        if let Some(target) = patch.album {
            if target != img.album {
                let (t_root, t_rel): (i64, String) = conn
                    .query_row(
                        "SELECT albumRoot, relativePath FROM Albums WHERE id = ?1",
                        [target],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?
                    .ok_or_else(|| {
                        AppError::Unprocessable(format!("unknown album id {target}"))
                    })?;
                let src_root = state.roots.get(&img.album_root).ok_or_else(|| {
                    AppError::Unprocessable(format!("album root {} unknown", img.album_root))
                })?;
                let dst_root = state.roots.get(&t_root).ok_or_else(|| {
                    AppError::Unprocessable(format!("album root {t_root} unknown"))
                })?;
                let name = &img.name;
                let old_abs = image_abs_path(src_root, &img.relative_path, name);
                let new_abs = image_abs_path(dst_root, &t_rel, name);
                // Preflight: refuse DB/filesystem drift rather than papering
                // over it. (An existing file at the target is refused by the
                // no-clobber move itself — a separate check would be racy.)
                let new_dir = new_abs.parent().expect("image path has a parent");
                if !new_dir.is_dir() {
                    return Err(AppError::Conflict(format!(
                        "target album directory missing: {}",
                        new_dir.display()
                    )));
                }
                // Digikam's UNIQUE (album, name) also covers rows with no file
                // on disk (e.g. trashed items), which the move can't see.
                conn.execute("UPDATE Images SET album = ?1 WHERE id = ?2", [target, id])
                    .map_err(|e| match e {
                        rusqlite::Error::SqliteFailure(f, _)
                            if f.code == rusqlite::ErrorCode::ConstraintViolation =>
                        {
                            AppError::Conflict(format!(
                                "the target album already has an item named \"{name}\" \
                                 (possibly trashed)"
                            ))
                        }
                        e => e.into(),
                    })?;
                move_no_clobber(&old_abs, &new_abs)
                    .map_err(|e| move_error(e, &old_abs, name))?;
                tracing::info!(id, from = %old_abs.display(), to = %new_abs.display(), "photo moved");
                moved = Some((old_abs, new_abs));
            }
        }

        if let Err(e) = tx.commit() {
            // The file already moved; put it back (best effort) so disk
            // matches the rolled-back DB.
            if let Some((old_abs, new_abs)) = &moved {
                if let Err(e2) = move_no_clobber(new_abs, old_abs) {
                    tracing::error!(id, error = %e2, "could not move file back after failed commit");
                }
            }
            return Err(e.into());
        }
        Ok(())
    })
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Move the file `from` to `to` without ever replacing whatever is at `to`
/// (including a dangling symlink, which `Path::exists` doesn't see). A plain
/// `rename` silently replaces the target, so instead hard-link the file into
/// place — which fails with `AlreadyExists`, atomically, if `to` exists — and
/// then drop the old link. Same-filesystem only, like `rename`; the inode is
/// unchanged, so content, mtime (and thus `uniqueHash`/thumbnails) are kept.
///
/// Filesystems without hard links (FAT/exFAT, some network mounts) fall back to
/// a checked `rename`, which narrows the race but can't close it.
fn move_no_clobber(from: &std::path::Path, to: &std::path::Path) -> io::Result<()> {
    match fs::hard_link(from, to) {
        Ok(()) => {
            if let Err(e) = fs::remove_file(from) {
                // Keep a single copy: undo the new link (best effort).
                let _ = fs::remove_file(to);
                return Err(e);
            }
            Ok(())
        }
        Err(e)
            if matches!(
                e.kind(),
                ErrorKind::Unsupported | ErrorKind::PermissionDenied
            ) =>
        {
            if to.symlink_metadata().is_ok() {
                return Err(ErrorKind::AlreadyExists.into());
            }
            fs::rename(from, to)
        }
        Err(e) => Err(e),
    }
}

/// Map a failed move to a client-facing error: an existing file at the target,
/// a cross-filesystem move, or a source file missing on disk is a 409 (the
/// request conflicts with the state of the world), anything else is a 500.
fn move_error(e: io::Error, from: &std::path::Path, name: &str) -> AppError {
    match e.kind() {
        ErrorKind::AlreadyExists => AppError::Conflict(format!(
            "a file named \"{name}\" already exists in the target album"
        )),
        ErrorKind::CrossesDevices => {
            AppError::Conflict("moving across filesystems is not supported (yet)".into())
        }
        ErrorKind::NotFound => {
            AppError::Conflict(format!("file missing on disk: {}", from.display()))
        }
        _ => AppError::Internal(anyhow::anyhow!("moving {}: {e}", from.display())),
    }
}

/// Resolve a tag id to its absolute path (`/places/beach`) for the change log,
/// doubling as validation: a 422 for an id that doesn't exist or that belongs to
/// Digikam's internal tag subtree (Color/Pick labels etc. — not user tags).
fn checked_tag_path(conn: &PooledConn, tag: i64) -> AppResult<String> {
    let internal = tag == INTERNAL_TAG_ROOT
        || conn
            .query_row(
                "SELECT 1 FROM TagsTree WHERE id = ?1 AND pid = ?2",
                [tag, INTERNAL_TAG_ROOT],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
    if internal {
        return Err(AppError::Unprocessable(format!(
            "tag {tag} is a Digikam-internal tag"
        )));
    }
    // Walk up the `pid` chain to the root, prepending each ancestor's name
    // (the single-tag version of get_photo's tag-path CTE).
    conn.query_row(
        "WITH RECURSIVE up(pid, path) AS ( \
           SELECT pid, name FROM Tags WHERE id = ?1 \
           UNION ALL \
           SELECT t.pid, t.name || '/' || up.path FROM up JOIN Tags t ON t.id = up.pid \
           WHERE up.pid <> 0 \
         ) \
         SELECT '/' || path FROM up WHERE pid = 0",
        [tag],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::Unprocessable(format!("unknown tag id {tag}")))
}

/// Render a stored rating for the change log: `-1` / no row = "unrated".
fn fmt_rating(r: Option<i64>) -> String {
    match r {
        Some(n) if n >= 0 => n.to_string(),
        _ => "unrated".into(),
    }
}
