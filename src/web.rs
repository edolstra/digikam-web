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
use crate::query::{self, PhotoQuery};

/// Inline stylesheet for the album grid. Photos are fixed-height and wrap
/// left-to-right, top-to-bottom; each day forms its own grid under a heading.
const STYLE: &str = "\
body { font-family: sans-serif; margin: 1rem; background: #111; color: #eee; }
/* Breadcrumb navbar: pinned to the top, full-width (negative margins break out
   of the body padding), staying put while the page scrolls underneath. The
   breadcrumb sits on the left, the rating selector on the right. */
.navbar { position: sticky; top: 0; z-index: 100;
          margin: -1rem -1rem 1rem; padding: 0.6rem 1rem;
          background: #1a1a1a; border-bottom: 1px solid #333;
          display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.crumb { font-size: 1.2rem; font-weight: 600; }
.crumb a { color: #6cf; text-decoration: none; }
.crumb a:hover { text-decoration: underline; }
.crumb .home { font-size: 1.3rem; }
.crumb .sep { color: #666; margin: 0 0.2rem; }
.rating { white-space: nowrap; }
.rating a { color: #555; text-decoration: none; font-size: 1.2rem; padding: 0 1px; }
.rating a.on { color: #f5c518; }
.rating a:hover { color: #f5c518; }
h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; padding-bottom: 0.25rem;
     border-bottom: 1px solid #333; color: #aaa; }
.count { color: #888; font-size: 0.85rem; }
.albums { display: flex; flex-wrap: wrap; gap: 10px; margin: 0.5rem 0 1.5rem; }
.album { position: relative; width: 200px; height: 150px; display: block;
         text-decoration: none; border-radius: 4px; overflow: hidden; background: #222; }
.album img { width: 200px; height: 150px; object-fit: cover; display: block;
             background: #222; }
.album .caption { position: absolute; inset: 0; display: flex;
                  flex-direction: column; align-items: center; justify-content: center;
                  text-align: center; gap: 0.2rem; padding: 0.5rem;
                  color: #fff; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
                  background: rgba(0, 0, 0, 0.3); }
.album:hover .caption { background: rgba(0, 0, 0, 0.45); }
.album .title { font-weight: bold; }
.album .cnt { font-size: 0.8rem; }
.grid { display: flex; flex-wrap: wrap; gap: 4px; align-items: flex-end; }
.grid img { height: 200px; width: auto; display: block; background: #222; cursor: pointer; }
body.modal-open { overflow: hidden; }
.lightbox { position: fixed; inset: 0; z-index: 1000; display: none;
            align-items: center; justify-content: center;
            background: rgba(0, 0, 0, 0.9); }
.lightbox.open { display: flex; }
.lightbox img.full { max-width: 100vw; max-height: 100vh; object-fit: contain; }
.lightbox .close { position: absolute; top: 0.25rem; right: 0.75rem;
                   font-size: 2.5rem; line-height: 1; }
.lightbox .nav { position: absolute; top: 50%; transform: translateY(-50%);
                 font-size: 3rem; padding: 0 1rem; }
.lightbox .prev { left: 0; }
.lightbox .next { right: 0; }
.lightbox button { background: none; border: 0; color: #fff; cursor: pointer;
                   user-select: none; opacity: 0.8; }
.lightbox button:hover { opacity: 1; }
.lightbox button[disabled] { opacity: 0.15; cursor: default; }
";

/// Inline lightbox behavior. No server data is interpolated here (static string);
/// the enlarged `src`/`alt` are read from the already-escaped grid `<img>` attributes.
const SCRIPT: &str = r#"
(function () {
  var imgs = Array.prototype.slice.call(document.querySelectorAll('.grid img'));
  var lb = document.getElementById('lightbox');
  var full = document.getElementById('lb-img');
  var prev = lb.querySelector('.prev');
  var next = lb.querySelector('.next');
  var idx = -1;

  function isOpen() { return lb.classList.contains('open'); }

  function show(i) {
    if (i < 0 || i >= imgs.length) return;
    idx = i;
    full.src = imgs[i].src;
    full.alt = imgs[i].alt;
    prev.disabled = (i === 0);
    next.disabled = (i === imgs.length - 1);
    lb.classList.add('open');
    document.body.classList.add('modal-open');
  }

  function close() {
    lb.classList.remove('open');
    document.body.classList.remove('modal-open');
    full.removeAttribute('src');
    idx = -1;
  }

  function go(d) {
    var n = idx + d;
    if (n >= 0 && n < imgs.length) show(n);
  }

  imgs.forEach(function (im, i) {
    im.addEventListener('click', function () { show(i); });
  });

  // Clicking the dimmed backdrop (but not the image or buttons) dismisses.
  lb.addEventListener('click', function (e) { if (e.target === lb) close(); });
  lb.querySelector('.close').addEventListener('click', close);
  prev.addEventListener('click', function (e) { e.stopPropagation(); go(-1); });
  next.addEventListener('click', function (e) { e.stopPropagation(); go(1); });

  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(imgs.length - 1);
  });

  // Horizontal swipe: left -> next, right -> prev.
  var sx = 0, sy = 0;
  lb.addEventListener('touchstart', function (e) {
    var t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  lb.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0];
    var dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  }, { passive: true });
})();
"#;

/// The day a photo belongs to (`YYYY-MM-DD`), or `None` if it has no date.
fn photo_day(creation_date: Option<&str>) -> Option<&str> {
    creation_date.filter(|d| d.len() >= 10).map(|d| &d[..10])
}

/// The view filters that are reflected in the URL and carried across navigation.
/// Currently just a minimum rating; designed to grow (tags, date range, …) — add
/// a field, serialize it in [`Filters::query_string`], and every album/sub-album
/// link picks it up automatically.
#[derive(Debug, Clone, Default)]
struct Filters {
    /// Minimum rating, 1..=5; `None` means no rating filter.
    min_rating: Option<i64>,
}

impl Filters {
    /// The query-string suffix encoding the active filters, e.g. `?min_rating=3`
    /// (empty when nothing is active).
    fn query_string(&self) -> String {
        let mut params: Vec<String> = Vec::new();
        if let Some(r) = self.min_rating {
            params.push(format!("min_rating={r}"));
        }
        if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        }
    }

    /// A copy with `min_rating` changed, preserving any other active filters.
    fn with_min_rating(&self, min_rating: Option<i64>) -> Filters {
        Filters {
            min_rating,
            ..self.clone()
        }
    }
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
    let mut html =
        String::from("<a class=\"home\" href=\"/photos\" aria-label=\"Home\">\u{2302}</a>");
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
    let current = filters.min_rating;
    let cur = current.unwrap_or(0);
    let mut html = String::from("<span class=\"rating\">");
    for k in 1..=5 {
        // Toggle off when clicking the currently-selected threshold.
        let target = filters.with_min_rating(if Some(k) == current { None } else { Some(k) });
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
         <img id=\"lb-img\" class=\"full\" alt=\"\">\n\
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
    min_rating: Option<i64>,
}

/// `GET /photos` — the virtual top of the database: shows the album roots as if
/// they were sub-albums.
pub async fn root_page(State(state): State<AppState>) -> AppResult<Html<String>> {
    render(state, None, Filters::default()).await
}

/// `GET /photos/<album path>` — e.g. `/photos/Photos/Lego/Porsche911`. An empty
/// path (`/photos/`) is treated as the virtual root.
pub async fn album_page(
    State(state): State<AppState>,
    Path(path): Path<String>,
    Query(params): Query<AlbumViewParams>,
) -> AppResult<Html<String>> {
    let filters = Filters {
        // Out-of-range values are ignored (no filter) rather than rejected.
        min_rating: params.min_rating.filter(|r| (1..=5).contains(r)),
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
    let Some(album) = album else {
        // Virtual root: the album roots presented as sub-album tiles.
        let roots =
            run_blocking(&state, |conn, state| query::list_roots(conn, &state.roots)).await?;
        let crumb = breadcrumb("", &filters);
        let body = render_subalbums(&roots, &filters);
        return Ok(Html(page_html("Photos", &crumb, "", &body)));
    };

    let q = PhotoQuery {
        album: Some(album.clone()),
        recursive: false,
        tags: Vec::new(),
        min_rating: filters.min_rating,
        // No real pagination in this first cut; list everything in the album.
        limit: i64::MAX,
        offset: 0,
    };

    // Fetch the album's photos and its direct sub-albums on one connection.
    let album_for_subs = album.clone();
    let (page, subalbums) = run_blocking(&state, move |conn, state| {
        let page = query::list_photos(conn, &state.roots, &q)?;
        let subalbums = query::list_subalbums(conn, &state.roots, &album_for_subs)?;
        Ok((page, subalbums))
    })
    .await?;

    let albums_html = render_subalbums(&subalbums, &filters);

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
    let crumb = breadcrumb(&album, &filters);
    let controls = rating_selector(&album, &filters);
    let body = format!(
        "{albums_html}<p class=\"count\">{count} photo(s)</p>\n{content}",
        count = page.total,
    );
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
        assert_eq!(escape_html("a & b <c> \"d\""), "a &amp; b &lt;c&gt; &quot;d&quot;");
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
        let f = Filters { min_rating: Some(3) };
        assert_eq!(f.query_string(), "?min_rating=3");
        assert_eq!(Filters::default().query_string(), "");
        // Breadcrumb links carry the active filter.
        let html = breadcrumb("/Photos/Lego", &f);
        assert!(html.contains("href=\"/photos/Photos/Lego?min_rating=3\""));
    }

    #[test]
    fn rating_selector_toggles_and_fills() {
        let html = rating_selector("/Photos/Lego", &Filters { min_rating: Some(2) });
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
