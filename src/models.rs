use serde::{Deserialize, Serialize};

use crate::query::{Aspect, Rating};

/// The set of view filters active on an album page. Held separately from
/// `PhotoQuery` so it can be passed to `list_subalbums` and applied to the
/// photo grid, and embedded in a saved [`Bookmark`]. Designed to grow (tags,
/// date range, …). Note `recursive` is deliberately *not* here — it's a
/// `PhotoQuery`-only concern that `/subalbums` ignores.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Filters {
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
}

impl Default for Filters {
    fn default() -> Self {
        Filters {
            min_rating: Rating::default(),
            include_images: true,
            include_video: true,
            aspect: Aspect::All,
            tags: Vec::new(),
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
    /// File modification date (`Images.modificationDate`) — used for ordering and
    /// day-grouping. Preferred over Digikam's `creationDate` (the import time).
    pub modification_date: Option<String>,
    pub mime: Option<String>,
    /// True if this item is a video (Digikam `category = 2`).
    pub is_video: bool,
}

/// Extended per-image metadata, fetched lazily by the lightbox info panel (so it
/// stays out of the bulk `PhotoSummary`). Designed to grow (description, …).
#[derive(Debug, Serialize)]
pub struct PhotoMetadata {
    /// `ImageInformation.creationDate` (Digikam's import/EXIF time), if present.
    pub creation_date: Option<String>,
    /// GPS coordinates (`ImagePositions.latitudeNumber`/`longitudeNumber`), if present.
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub tags: Vec<String>,
}

/// Full detail for a single photo.
#[derive(Debug, Serialize)]
pub struct PhotoDetail {
    #[serde(flatten)]
    pub summary: PhotoSummary,
    pub tags: Vec<String>,
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
    /// Whether the recursive (include sub-albums) toggle was on.
    pub recursive: bool,
    #[serde(flatten)]
    pub filters: Filters,
}

/// Request body for `POST /api/bookmarks`.
#[derive(Debug, Deserialize)]
pub struct CreateBookmark {
    pub name: String,
    pub album: String,
    pub recursive: bool,
    #[serde(flatten)]
    pub filters: Filters,
    /// When true, replace an existing bookmark of the same name instead of
    /// failing with a conflict.
    #[serde(default)]
    pub overwrite: bool,
}
