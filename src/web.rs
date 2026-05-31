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
h1 a { color: #6cf; text-decoration: none; }
h1 a:hover { text-decoration: underline; }
h1 .sep { color: #666; margin: 0 0.2rem; }
h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; padding-bottom: 0.25rem;
     border-bottom: 1px solid #333; color: #aaa; }
.count { color: #888; font-size: 0.85rem; }
.albums { display: flex; flex-wrap: wrap; gap: 10px; margin: 0.5rem 0 1.5rem; }
.album { width: 200px; text-decoration: none; color: #ccc; }
.album img { width: 200px; height: 150px; object-fit: cover; display: block;
             background: #222; border-radius: 4px; }
.album .name { display: block; font-size: 0.8rem; margin-top: 0.25rem;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.album .cnt { color: #888; }
.album:hover .name { color: #fff; }
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

/// The frontend URL for an album display path, e.g. `/Photos/Lego` ->
/// `/photos/Photos/Lego`, percent-encoding each path segment.
fn album_href(album: &str) -> String {
    let mut href = String::from("/photos");
    for segment in album.split('/').filter(|s| !s.is_empty()) {
        href.push('/');
        href.push_str(&urlencoding::encode(segment));
    }
    href
}

/// Render an album path like `/Photos/Lego/Porsche911` as a clickable breadcrumb
/// `› Photos › Lego › Porsche911`, where each segment links to that album page.
fn breadcrumb(album: &str) -> String {
    let mut html = String::new();
    let mut prefix = String::new();
    for segment in album.split('/').filter(|s| !s.is_empty()) {
        prefix.push('/');
        prefix.push_str(segment);
        html.push_str(&format!(
            "<span class=\"sep\">\u{203a}</span><a href=\"{href}\">{label}</a>",
            href = escape_html(&album_href(&prefix)),
            label = escape_html(segment),
        ));
    }
    html
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

    // Fetch the album's photos and its direct sub-albums on one connection.
    let album_for_subs = album.clone();
    let (page, subalbums) = run_blocking(&state, move |conn, state| {
        let page = query::list_photos(conn, &state.roots, &q)?;
        let subalbums = query::list_subalbums(conn, &state.roots, &album_for_subs)?;
        Ok((page, subalbums))
    })
    .await?;

    // Grid of sub-albums (cover + name + count), shown above the photos.
    let mut albums_html = String::new();
    if !subalbums.is_empty() {
        albums_html.push_str("<div class=\"albums\">\n");
        for sub in &subalbums {
            albums_html.push_str(&format!(
                "<a class=\"album\" href=\"{href}\">\
                 <img src=\"/api/photos/{cover_id}/file\" alt=\"{alt}\" loading=\"lazy\">\
                 <span class=\"name\">{name} <span class=\"cnt\">({count})</span></span>\
                 </a>\n",
                href = escape_html(&album_href(&sub.path)),
                cover_id = sub.cover.id,
                alt = escape_html(&sub.cover.name),
                name = escape_html(&sub.name),
                count = sub.photo_count,
            ));
        }
        albums_html.push_str("</div>\n");
    }

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
    let crumb = breadcrumb(&album);
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
         <h1>{crumb}</h1>\n\
         {albums_html}\
         <p class=\"count\">{count} photo(s)</p>\n\
         {content}\
         <div id=\"lightbox\" class=\"lightbox\">\n\
         <button class=\"close\" aria-label=\"Close\">\u{00d7}</button>\n\
         <button class=\"nav prev\" aria-label=\"Previous\">\u{2039}</button>\n\
         <img id=\"lb-img\" class=\"full\" alt=\"\">\n\
         <button class=\"nav next\" aria-label=\"Next\">\u{203a}</button>\n\
         </div>\n\
         <script>{SCRIPT}</script>\n\
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
    fn builds_breadcrumb() {
        let html = breadcrumb("/Photos/Lego/Porsche911");
        assert!(html.contains("<a href=\"/photos/Photos\">Photos</a>"));
        assert!(html.contains("<a href=\"/photos/Photos/Lego\">Lego</a>"));
        assert!(html.contains("<a href=\"/photos/Photos/Lego/Porsche911\">Porsche911</a>"));
    }

    #[test]
    fn breadcrumb_encodes_and_escapes() {
        // Spaces are percent-encoded in the href; the label stays human-readable.
        let html = breadcrumb("/My Photos");
        assert!(html.contains("href=\"/photos/My%20Photos\""));
        assert!(html.contains(">My Photos</a>"));
    }

    #[test]
    fn extracts_day() {
        assert_eq!(photo_day(Some("2011-11-06T07:40:07")), Some("2011-11-06"));
        assert_eq!(photo_day(Some("2026-05-31")), Some("2026-05-31"));
        assert_eq!(photo_day(Some("bad")), None);
        assert_eq!(photo_day(None), None);
    }
}
