//! Server-rendered HTML frontend.
//!
//! Currently a minimal starting point: a single page that lists the file names
//! of the photos in a given album path. This will grow into the real browsing UI.

use axum::extract::{Path, Query, State};
use axum::response::Html;
use serde::Deserialize;

use crate::db::AppState;
use crate::error::AppResult;
use crate::handlers::run_blocking;
use crate::models::SubAlbum;
use crate::query::{self, Filters, PhotoQuery, Rating};

/// Stylesheet for the frontend pages (inlined into each page's `<style>`).
const STYLE: &str = include_str!("web.css");

/// Lightbox behavior (inlined into each page's `<script>`). No server data is
/// interpolated; media URLs are read from the grid `<img src>` / `.vtile`
/// `data-src` attributes. Photos use `#lb-img`, videos `#lb-video`.
const SCRIPT: &str = include_str!("web.js");

/// The day a photo belongs to (`YYYY-MM-DD`), or `None` if it has no date.
fn photo_day(creation_date: Option<&str>) -> Option<&str> {
    creation_date.filter(|d| d.len() >= 10).map(|d| &d[..10])
}

/// The frontend URL for an album display path, e.g. `/Photos/Lego` ->
/// `/photos/Photos/Lego`, percent-encoding each path segment and appending the
/// active filters so they are carried along.
fn album_href(album: &str, filters: &Filters) -> String {
    let mut href = String::from("/photos");
    for segment in album.split('/').filter(|s| !s.is_empty()) {
        href.push('/');
        href.push_str(&urlencoding::encode(segment));
    }
    href.push_str(&filters.query_string());
    href
}

/// Render an album path like `/Photos/Lego/Porsche911` as a clickable breadcrumb
/// `⌂ › Photos › Lego › Porsche911`. The leading house symbol links to `/photos`
/// (the top of the database); each segment links to that album page, carrying the
/// active filters.
fn breadcrumb(album: &str, filters: &Filters) -> String {
    // The home link points at the virtual root, carrying the active filters.
    let mut html = format!(
        "<a class=\"home\" href=\"{href}\" aria-label=\"Home\">\u{2302}</a>",
        href = escape_html(&album_href("", filters)),
    );
    let mut prefix = String::new();
    for segment in album.split('/').filter(|s| !s.is_empty()) {
        prefix.push('/');
        prefix.push_str(segment);
        html.push_str(&format!(
            "<span class=\"sep\">\u{203a}</span><a href=\"{href}\">{label}</a>",
            href = escape_html(&album_href(&prefix, filters)),
            label = escape_html(segment),
        ));
    }
    html
}

/// Render the navbar's rating selector: five stars where the first `min_rating`
/// are gold. Clicking star K filters to `≥K`; clicking the active threshold again
/// clears it. Links keep the other filters and the current album.
fn rating_selector(album: &str, filters: &Filters) -> String {
    let cur = filters.min_rating.get();
    let mut html = String::from("<span class=\"rating\">");
    for k in 1..=5 {
        // Toggle off (back to Rating(0)) when clicking the active threshold.
        let target =
            filters.with_min_rating(Rating::new(if cur == k { 0 } else { k }).unwrap_or_default());
        let (class, star) = if k <= cur {
            (" class=\"on\"", '\u{2605}')
        } else {
            ("", '\u{2606}')
        };
        html.push_str(&format!(
            "<a{class} href=\"{href}\" title=\"\u{2265}{k} stars\">{star}</a>",
            href = escape_html(&album_href(album, &target)),
        ));
    }
    html.push_str("</span>");
    html
}

/// Render a grid of sub-album tiles (cover with the bold title + count overlaid).
/// Empty input yields an empty string; video-only sub-albums (no cover) get a
/// plain dark tile. Tile links carry the active filters.
fn render_subalbums(subalbums: &[SubAlbum], filters: &Filters) -> String {
    if subalbums.is_empty() {
        return String::new();
    }
    let mut html = String::from("<div class=\"albums\">\n");
    for sub in subalbums {
        let cover_img = match &sub.cover {
            Some(cover) => format!(
                "<img src=\"/api/photos/{id}/file\" alt=\"{alt}\" loading=\"lazy\">",
                id = cover.id,
                alt = escape_html(&cover.name),
            ),
            None => String::new(),
        };
        html.push_str(&format!(
            "<a class=\"album\" href=\"{href}\">\
             {cover_img}\
             <span class=\"caption\">\
             <span class=\"title\">{name}</span>\
             <span class=\"cnt\">({count})</span>\
             </span>\
             </a>\n",
            href = escape_html(&album_href(&sub.path, filters)),
            name = escape_html(&sub.name),
            count = sub.photo_count,
        ));
    }
    html.push_str("</div>\n");
    html
}

/// Assemble a full HTML page. `title`, `crumb` and `controls` must already be
/// HTML-safe. `controls` is the right-hand side of the navbar (e.g. the rating
/// selector), or empty.
fn page_html(title: &str, crumb: &str, controls: &str, body: &str) -> String {
    format!(
        "<!DOCTYPE html>\n\
         <html lang=\"en\">\n\
         <head>\n\
         <meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{title}</title>\n\
         <style>\n{STYLE}</style>\n\
         </head>\n\
         <body>\n\
         <header class=\"navbar\"><span class=\"crumb\">{crumb}</span>{controls}</header>\n\
         {body}\
         <div id=\"lightbox\" class=\"lightbox\">\n\
         <button class=\"close\" aria-label=\"Close\">\u{00d7}</button>\n\
         <button class=\"nav prev\" aria-label=\"Previous\">\u{2039}</button>\n\
         <img id=\"lb-img\" class=\"full\" alt=\"\" decoding=\"async\">\n\
         <video id=\"lb-video\" class=\"full\" playsinline loop></video>\n\
         <button class=\"nav next\" aria-label=\"Next\">\u{203a}</button>\n\
         </div>\n\
         <script>{SCRIPT}</script>\n\
         </body>\n\
         </html>\n",
    )
}

/// Query parameters parsed from the album page URL into [`Filters`].
#[derive(Debug, Deserialize)]
pub struct AlbumViewParams {
    #[serde(default)]
    min_rating: Rating,
}

/// `GET /photos` — the virtual top of the database: shows the album roots as if
/// they were sub-albums.
pub async fn root_page(
    State(state): State<AppState>,
    Query(params): Query<AlbumViewParams>,
) -> AppResult<Html<String>> {
    let filters = Filters {
        min_rating: params.min_rating,
    };
    render(state, None, filters).await
}

/// `GET /photos/<album path>` — e.g. `/photos/Photos/Lego/Porsche911`. An empty
/// path (`/photos/`) is treated as the virtual root.
pub async fn album_page(
    State(state): State<AppState>,
    Path(path): Path<String>,
    Query(params): Query<AlbumViewParams>,
) -> AppResult<Html<String>> {
    let filters = Filters {
        min_rating: params.min_rating,
    };
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return render(state, None, filters).await;
    }
    render(state, Some(format!("/{trimmed}")), filters).await
}

/// Render the album browsing page. `album` is `None` for the virtual root (album
/// roots shown as tiles, no photo grid), or `Some("/Root/rel")` for a real album.
async fn render(
    state: AppState,
    album: Option<String>,
    filters: Filters,
) -> AppResult<Html<String>> {
    // "" is the virtual root (album roots as tiles, no photo grid); a non-empty
    // path is a real album (sub-album tiles + its own photo grid). `list_subalbums`
    // handles both; only a real album also runs a `PhotoQuery`.
    let album = album.unwrap_or_default();
    let q = (!album.is_empty()).then(|| PhotoQuery {
        album: Some(album.clone()),
        recursive: false,
        tags: Vec::new(),
        min_rating: filters.min_rating,
        // No real pagination in this first cut; list everything in the album.
        limit: u64::MAX,
        offset: 0,
    });

    // Fetch the (optional) photo page and the sub-album tiles on one connection.
    let album_for_subs = album.clone();
    let filters_for_subs = filters.clone();
    let (page, subalbums) = run_blocking(&state, move |conn, state| {
        let page = match &q {
            Some(q) => Some(query::list_photos(conn, &state.roots, q)?),
            None => None,
        };
        let subalbums =
            query::list_subalbums(conn, &state.roots, &album_for_subs, &filters_for_subs)?;
        Ok((page, subalbums))
    })
    .await?;

    let albums_html = render_subalbums(&subalbums, &filters);

    // The photo grid + count line, present only for a real album.
    let grid = match &page {
        None => String::new(),
        Some(page) => {
            let mut content = String::new();
            if page.items.is_empty() {
                content.push_str("<p>No photos in this album.</p>");
            } else {
                // `list_photos` already orders newest-first, so photos of the same
                // day are contiguous: group them by walking the list once.
                let mut current_day: Option<&str> = None;
                let mut grid_open = false;
                for photo in &page.items {
                    let day = photo_day(photo.creation_date.as_deref());
                    if day != current_day {
                        if grid_open {
                            content.push_str("</div>\n");
                        }
                        let heading = day.unwrap_or("Unknown date");
                        content.push_str(&format!(
                            "<h2>{}</h2>\n<div class=\"grid\">\n",
                            escape_html(heading)
                        ));
                        grid_open = true;
                        current_day = day;
                    }
                    if photo.is_video {
                        // Placeholder tile (▶ badge via CSS); nothing is fetched
                        // until it's opened. `data-src` carries the media URL.
                        content.push_str(&format!(
                            "<button class=\"vtile\" data-src=\"/api/photos/{id}/file\" title=\"{name}\"></button>\n",
                            id = photo.id,
                            name = escape_html(&photo.name),
                        ));
                    } else {
                        // Originals are full-size, so let the browser load lazily.
                        content.push_str(&format!(
                            "<img src=\"/api/photos/{id}/file\" alt=\"{alt}\" loading=\"lazy\">\n",
                            id = photo.id,
                            alt = escape_html(&photo.name),
                        ));
                    }
                }
                if grid_open {
                    content.push_str("</div>\n");
                }
            }
            format!("<p class=\"count\">{} photo(s)</p>\n{content}", page.total)
        }
    };

    let title = if album.is_empty() {
        "Photos".to_string()
    } else {
        escape_html(&album)
    };
    let crumb = breadcrumb(&album, &filters);
    let controls = rating_selector(&album, &filters);
    let body = format!("{albums_html}{grid}");
    Ok(Html(page_html(&title, &crumb, &controls, &body)))
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
        assert_eq!(
            escape_html("a & b <c> \"d\""),
            "a &amp; b &lt;c&gt; &quot;d&quot;"
        );
    }

    #[test]
    fn builds_breadcrumb() {
        let html = breadcrumb("/Photos/Lego/Porsche911", &Filters::default());
        assert!(html.contains("<a href=\"/photos/Photos\">Photos</a>"));
        assert!(html.contains("<a href=\"/photos/Photos/Lego\">Lego</a>"));
        assert!(html.contains("<a href=\"/photos/Photos/Lego/Porsche911\">Porsche911</a>"));
    }

    #[test]
    fn breadcrumb_encodes_and_escapes() {
        // Spaces are percent-encoded in the href; the label stays human-readable.
        let html = breadcrumb("/My Photos", &Filters::default());
        assert!(html.contains("href=\"/photos/My%20Photos\""));
        assert!(html.contains(">My Photos</a>"));
    }

    #[test]
    fn filters_propagate_into_links() {
        let f = Filters {
            min_rating: Rating::new(3).unwrap(),
        };
        assert_eq!(f.query_string(), "?min_rating=3");
        assert_eq!(Filters::default().query_string(), "");
        // Breadcrumb links carry the active filter.
        let html = breadcrumb("/Photos/Lego", &f);
        assert!(html.contains("href=\"/photos/Photos/Lego?min_rating=3\""));
    }

    #[test]
    fn rating_selector_toggles_and_fills() {
        let html = rating_selector(
            "/Photos/Lego",
            &Filters {
                min_rating: Rating::new(2).unwrap(),
            },
        );
        // First two stars filled (on), and clicking star 2 again clears the filter.
        assert_eq!(html.matches("class=\"on\"").count(), 2);
        assert!(html.contains("href=\"/photos/Photos/Lego\" title=\"\u{2265}2 stars\""));
        // Star 4 raises the threshold.
        assert!(html.contains("href=\"/photos/Photos/Lego?min_rating=4\""));
    }

    #[test]
    fn extracts_day() {
        assert_eq!(photo_day(Some("2011-11-06T07:40:07")), Some("2011-11-06"));
        assert_eq!(photo_day(Some("2026-05-31")), Some("2026-05-31"));
        assert_eq!(photo_day(Some("bad")), None);
        assert_eq!(photo_day(None), None);
    }
}
