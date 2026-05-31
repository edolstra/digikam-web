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
