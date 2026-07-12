use serde::{Deserialize, Deserializer, Serialize};

use crate::query::{Aspect, Rating, Sort};

/// The set of view filters active on an album page. Held separately from
/// `PhotoQuery` so it can be passed to `list_subalbums` and applied to the
/// photo grid, and embedded in a saved [`Bookmark`]. Designed to grow (date
/// range, …).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Filters {
    /// When true, the album scope also matches sub-albums (the photo grid spans
    /// the whole subtree). Conceptually a filter — it decides whether sub-album
    /// items are kept — but `/subalbums` ignores it (its counts/covers are
    /// always recursive). Defaults to `false` (only the named album).
    #[serde(default)]
    pub recursive: bool,
    /// Minimum rating; the default `Rating(0)` means no rating filter.
    pub min_rating: Rating,
    /// Media-type filter; both `true` by default.
    pub include_images: bool,
    pub include_video: bool,
    /// Aspect-ratio filter; the default `All` applies no constraint.
    pub aspect: Aspect,
    /// Tag-filter tokens, AND'd; each matches a tag (and its subtree) by name or
    /// absolute path (see `resolve_tag_filter`). Empty = no tag filter.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Photo sort order; the default `Modified` is newest-first by modification
    /// date. Not a filter per se, but carried alongside them (and bookmarked).
    #[serde(default)]
    pub sort: Sort,
}

impl Default for Filters {
    fn default() -> Self {
        Filters {
            recursive: false,
            min_rating: Rating::default(),
            include_images: true,
            include_video: true,
            aspect: Aspect::All,
            tags: Vec::new(),
            sort: Sort::Modified,
        }
    }
}

/// A paginated response envelope.
#[derive(Debug, Serialize)]
pub struct Page<T> {
    pub incomplete: bool,
    pub limit: u64,
    pub offset: u64,
    pub items: Vec<T>,
}

/// Compact representation of a photo, used in list responses.
#[derive(Debug, Serialize)]
pub struct PhotoSummary {
    pub id: u64,
    pub name: String,
    /// Display album path, e.g. `/Photos/201110_Georgia`.
    pub album_path: String,
    pub file_size: Option<u64>,
    pub format: Option<String>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    /// Rating 0..=5. Digikam stores -1 for "unrated", which is reported as null.
    pub rating: Option<u64>,
    /// File modification date (`Images.modificationDate`) — the default ordering
    /// and day-grouping key. Preferred over Digikam's `creationDate` (import time).
    pub modification_date: Option<String>,
    /// `ImageInformation.creationDate` (Digikam's import/EXIF time), if present —
    /// used for ordering and day-grouping when sorting by creation date.
    pub creation_date: Option<String>,
    pub mime: Option<String>,
    /// True if this item is a video (Digikam `category = 2`).
    pub is_video: bool,
}

/// Full detail for a single photo (the lightbox info panel fetches this lazily,
/// for the fields not in the bulk `PhotoSummary`).
#[derive(Debug, Serialize)]
pub struct PhotoDetail {
    #[serde(flatten)]
    pub summary: PhotoSummary,
    /// Absolute path of the original file on the server (album-root base +
    /// `relativePath` + name); `None` if the album root is unknown.
    pub file_path: Option<String>,
    /// Image description: all of the image's `ImageComments` (Digikam stores
    /// captions/titles/imported EXIF-JFIF comments here) concatenated with
    /// newlines; `None` when the image has none.
    pub description: Option<String>,
    /// Tags as absolute paths (`/vacation/2020/beach`), internal tags excluded.
    pub tags: Vec<String>,
    /// GPS coordinates (`ImagePositions.latitudeNumber`/`longitudeNumber`), if present.
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

/// One album in the flat album listing.
#[derive(Debug, Serialize)]
pub struct AlbumNode {
    pub id: u64,
    /// Display path, e.g. `/Photos/Lego/Porsche911`.
    pub path: String,
    /// Album root label, e.g. `Photos`.
    pub root: String,
}

/// A node in the tag tree.
#[derive(Debug, Serialize)]
pub struct TagNode {
    pub id: u64,
    pub name: String,
    pub children: Vec<TagNode>,
}

/// The cover item used to represent a sub-album — the newest image **or video**
/// in its subtree (videos have stored thumbnails the client can render).
#[derive(Debug, Serialize)]
pub struct Cover {
    pub id: u64,
    pub name: String,
    /// True for a video cover: it has a thumbnail but no still to fall back to,
    /// so the client doesn't set `data-full` on its tile.
    pub is_video: bool,
}

/// A direct sub-album of some album, with its cover and recursive photo count.
#[derive(Debug, Serialize)]
pub struct SubAlbum {
    /// The sub-album's own name (the last path segment), e.g. `Porsche911`.
    pub name: String,
    /// Display path, e.g. `/Photos/Lego/Porsche911`.
    pub path: String,
    /// Number of visible photos in the sub-album's whole subtree.
    pub photo_count: u64,
    /// Most recent image in the subtree, or `None` if it contains only videos.
    pub cover: Option<Cover>,
}

/// A saved view: a name plus the album + filter settings to jump back to.
/// Stored in the writable `web.sql` database (see [crate::db::build_web_pool]).
#[derive(Debug, Clone, Serialize)]
pub struct Bookmark {
    pub name: String,
    /// Album display path, e.g. `/Photos/Lego` (empty string = the virtual root).
    pub album: String,
    /// The saved view filters (incl. `recursive`); flattened into the JSON.
    #[serde(flatten)]
    pub filters: Filters,
}

/// Request body for `PATCH /api/photos/:id` — a partial update, so every field
/// is double-wrapped to distinguish **absent** (leave unchanged) from **`null`**
/// (clear): `None` = not mentioned, `Some(None)` = clear, `Some(Some(v))` = set.
/// Designed to grow (tags, album, …) as more write operations are added.
#[derive(Debug, Deserialize)]
pub struct PatchPhoto {
    /// New rating (0..=5), or `null` to clear back to Digikam's "unrated" (-1).
    #[serde(default, deserialize_with = "double_option")]
    pub rating: Option<Option<Rating>>,
    /// Tag ids (from `/api/tags`) to add to / remove from the photo. Collection
    /// deltas, not tri-state: absent or empty = no change. Already-present adds
    /// and absent removes are silent no-ops; an unknown or internal tag id is a
    /// 422.
    #[serde(default)]
    pub tags_add: Vec<i64>,
    #[serde(default)]
    pub tags_remove: Vec<i64>,
}

/// Deserialize a present-but-possibly-null field as `Some(inner)`, so that
/// combined with `#[serde(default)]` an absent field is `None` while an explicit
/// `null` is `Some(None)` (plain `Option<Option<T>>` can't tell them apart).
fn double_option<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Deserialize::deserialize(d).map(Some)
}

/// Request body for `POST /api/bookmarks`.
#[derive(Debug, Deserialize)]
pub struct CreateBookmark {
    pub name: String,
    pub album: String,
    #[serde(flatten)]
    pub filters: Filters,
    /// When true, replace an existing bookmark of the same name instead of
    /// failing with a conflict.
    #[serde(default)]
    pub overwrite: bool,
}
