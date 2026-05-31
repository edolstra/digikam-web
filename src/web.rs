//! Server-rendered HTML frontend.
//!
//! Currently a minimal starting point: a single page that lists the file names
//! of the photos in a given album path. This will grow into the real browsing UI.

use axum::extract::{Path, State};
use axum::response::Html;

use crate::db::AppState;
use crate::error::AppResult;
use crate::handlers::run_blocking;
use crate::query::{self, PhotoQuery};

/// Inline stylesheet for the album grid. Photos are fixed-height and wrap
/// left-to-right, top-to-bottom; each day forms its own grid under a heading.
const STYLE: &str = "\
body { font-family: sans-serif; margin: 1rem; background: #111; color: #eee; }
h1 { font-size: 1.2rem; font-weight: 600; }
h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; padding-bottom: 0.25rem;
     border-bottom: 1px solid #333; color: #aaa; }
.count { color: #888; font-size: 0.85rem; }
.grid { display: flex; flex-wrap: wrap; gap: 4px; align-items: flex-end; }
.grid img { height: 200px; width: auto; display: block; background: #222; }
";

/// The day a photo belongs to (`YYYY-MM-DD`), or `None` if it has no date.
fn photo_day(creation_date: Option<&str>) -> Option<&str> {
    creation_date.filter(|d| d.len() >= 10).map(|d| &d[..10])
}

/// `GET /photos/<album path>` — e.g. `/photos/Photos/Lego/Porsche911`.
///
/// Renders the photos directly in that album (non-recursive) as a grid,
/// grouped by day (newest first). Uses the original-file endpoint directly;
/// no thumbnails or pagination yet.
pub async fn album_page(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> AppResult<Html<String>> {
    // The captured path maps onto an album display path, e.g.
    // `Photos/Lego/Porsche911` -> `/Photos/Lego/Porsche911`.
    let album = format!("/{}", path.trim_matches('/'));

    let q = PhotoQuery {
        album: Some(album.clone()),
        recursive: false,
        tags: Vec::new(),
        // No real pagination in this first cut; list everything in the album.
        limit: i64::MAX,
        offset: 0,
    };

    let page = run_blocking(&state, move |conn, state| {
        query::list_photos(conn, &state.roots, &q)
    })
    .await?;

    // `list_photos` already orders newest-first, so photos of the same day are
    // contiguous: we can group them by walking the list once.
    let mut content = String::new();
    if page.items.is_empty() {
        content.push_str("<p>No photos in this album.</p>");
    } else {
        let mut current_day: Option<&str> = None;
        let mut grid_open = false;
        for photo in &page.items {
            let day = photo_day(photo.creation_date.as_deref());
            if day != current_day {
                if grid_open {
                    content.push_str("</div>\n");
                }
                let heading = day.unwrap_or("Unknown date");
                content.push_str(&format!("<h2>{}</h2>\n<div class=\"grid\">\n", escape_html(heading)));
                grid_open = true;
                current_day = day;
            }
            // Originals are full-size, so let the browser load lazily.
            content.push_str(&format!(
                "<img src=\"/api/photos/{id}/file\" alt=\"{alt}\" loading=\"lazy\">\n",
                id = photo.id,
                alt = escape_html(&photo.name),
            ));
        }
        if grid_open {
            content.push_str("</div>\n");
        }
    }

    let title = escape_html(&album);
    let body = format!(
        "<!DOCTYPE html>\n\
         <html lang=\"en\">\n\
         <head>\n\
         <meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{title}</title>\n\
         <style>\n{STYLE}</style>\n\
         </head>\n\
         <body>\n\
         <h1>{title}</h1>\n\
         <p class=\"count\">{count} photo(s)</p>\n\
         {content}\
         </body>\n\
         </html>\n",
        count = page.total,
    );

    Ok(Html(body))
}

/// Minimal HTML-text escaping for interpolated values.
fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_html() {
        assert_eq!(escape_html("a & b <c> \"d\""), "a &amp; b &lt;c&gt; &quot;d&quot;");
    }

    #[test]
    fn extracts_day() {
        assert_eq!(photo_day(Some("2011-11-06T07:40:07")), Some("2011-11-06"));
        assert_eq!(photo_day(Some("2026-05-31")), Some("2026-05-31"));
        assert_eq!(photo_day(Some("bad")), None);
        assert_eq!(photo_day(None), None);
    }
}
