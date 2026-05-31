use serde::Serialize;

/// A paginated response envelope.
#[derive(Debug, Serialize)]
pub struct Page<T> {
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
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
    pub creation_date: Option<String>,
    pub mime: Option<String>,
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

/// The cover image used to represent a sub-album.
#[derive(Debug, Serialize)]
pub struct Cover {
    pub id: u64,
    pub name: String,
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
