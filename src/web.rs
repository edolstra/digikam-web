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

/// `GET /photos/<album path>` — e.g. `/photos/Photos/Lego/Porsche911`.
///
/// Lists the photos directly in that album (non-recursive) as a plain HTML page.
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

    let mut list = String::new();
    if page.items.is_empty() {
        list.push_str("<p>No photos in this album.</p>");
    } else {
        list.push_str("<ul>");
        for photo in &page.items {
            list.push_str("<li>");
            list.push_str(&escape_html(&photo.name));
            list.push_str("</li>");
        }
        list.push_str("</ul>");
    }

    let title = escape_html(&album);
    let body = format!(
        "<!DOCTYPE html>\n\
         <html lang=\"en\">\n\
         <head>\n\
         <meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{title}</title>\n\
         </head>\n\
         <body>\n\
         <h1>{title}</h1>\n\
         <p>{count} photo(s)</p>\n\
         {list}\n\
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
}
