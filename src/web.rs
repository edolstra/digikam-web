//! Server-rendered HTML frontend, built with [`maud`] (compile-time templates
//! with automatic escaping). This is the seed of the browsing UI.

use axum::extract::{Path, Query, State};
use maud::{html, Markup, PreEscaped, DOCTYPE};
use serde::Deserialize;

use crate::db::AppState;
use crate::error::AppResult;
use crate::handlers::run_blocking;
use crate::models::{PhotoSummary, SubAlbum};
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

/// The frontend URL for album path segments, e.g. `["Photos", "Lego"]` ->
/// `/photos/Photos/Lego`, percent-encoding each segment and appending the active
/// filters so they are carried along. `[]` is the root (`/photos`).
fn album_href(album: &[String], filters: &Filters) -> String {
    let mut href = String::from("/photos");
    for segment in album {
        href.push('/');
        href.push_str(&urlencoding::encode(segment));
    }
    href.push_str(&filters.query_string());
    href
}

/// `album` segments extended with one more child segment.
fn child(album: &[String], name: &str) -> Vec<String> {
    let mut segments = album.to_vec();
    segments.push(name.to_string());
    segments
}

/// Render album path segments as a clickable breadcrumb
/// `⌂ › Photos › Lego › Porsche911`. The leading house symbol links to `/photos`
/// (the top of the database); each segment links to that album page, carrying the
/// active filters.
fn breadcrumb(album: &[String], filters: &Filters) -> Markup {
    html! {
        a.home href=(album_href(&[], filters)) aria-label="Home" { "⌂" }
        @for i in 0..album.len() {
            span.sep { "›" }
            // `album[..=i]` is the cumulative path up to and including segment i.
            a href=(album_href(&album[..=i], filters)) { (album[i]) }
        }
    }
}

/// Render the navbar's rating selector: five stars where the first `min_rating`
/// are gold. Clicking star K filters to `≥K`; clicking the active threshold again
/// clears it. Links keep the other filters and the current album.
fn rating_selector(album: &[String], filters: &Filters) -> Markup {
    let cur = filters.min_rating.get();
    html! {
        span.rating {
            @for k in 1..=5 {
                // Toggle off (back to Rating(0)) when clicking the active threshold.
                @let target =
                    filters.with_min_rating(Rating::new(if cur == k { 0 } else { k }).unwrap_or_default());
                @let on = k <= cur;
                a.on[on] href=(album_href(album, &target)) title=(format!("≥{k} stars")) {
                    @if on { "★" } @else { "☆" }
                }
            }
        }
    }
}

/// Render a grid of sub-album tiles (cover with the bold title + count overlaid).
/// Empty input yields empty markup; video-only sub-albums (no cover) get a plain
/// dark tile. Tile links carry the active filters.
fn render_subalbums(album: &[String], subalbums: &[SubAlbum], filters: &Filters) -> Markup {
    html! {
        @if !subalbums.is_empty() {
            div.albums {
                @for sub in subalbums {
                    a.album href=(album_href(&child(album, &sub.name), filters)) {
                        @if let Some(cover) = &sub.cover {
                            img src=(format!("/api/photos/{}/file", cover.id))
                                alt=(cover.name) loading="lazy";
                        }
                        span.caption {
                            span.title { (sub.name) }
                            " "
                            span.cnt { "(" (sub.photo_count) ")" }
                        }
                    }
                }
            }
        }
    }
}

/// Group photos into contiguous runs by day. `list_photos` already orders
/// newest-first, so a single pass suffices.
fn group_by_day(items: &[PhotoSummary]) -> Vec<(&str, Vec<&PhotoSummary>)> {
    let mut groups: Vec<(&str, Vec<&PhotoSummary>)> = Vec::new();
    for photo in items {
        let day = photo_day(photo.creation_date.as_deref()).unwrap_or("Unknown date");
        match groups.last_mut() {
            Some((d, v)) if *d == day => v.push(photo),
            _ => groups.push((day, vec![photo])),
        }
    }
    groups
}

/// Assemble a full HTML page. `controls` is the right-hand side of the navbar
/// (e.g. the rating selector), or empty.
fn page_html(title: &str, crumb: Markup, controls: Markup, body: Markup) -> Markup {
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                title { (title) }
                style { (PreEscaped(STYLE)) }
            }
            body {
                header.navbar {
                    span.crumb { (crumb) }
                    (controls)
                }
                (body)
                div.lightbox id="lightbox" {
                    button.close aria-label="Close" { "×" }
                    button.nav.prev aria-label="Previous" { "‹" }
                    img.full id="lb-img" alt="" decoding="async";
                    video.full id="lb-video" playsinline loop {}
                    button.nav.next aria-label="Next" { "›" }
                }
                script { (PreEscaped(SCRIPT)) }
            }
        }
    }
}

/// Query parameters parsed from the album page URL into [`Filters`].
#[derive(Debug, Deserialize)]
pub struct AlbumViewParams {
    #[serde(default)]
    min_rating: Rating,
}

/// The album browsing page, serving `/`, `/photos`, and `/photos/<album path>`.
/// An empty/absent path (`/`, `/photos`) is the virtual root (album roots shown
/// as tiles); `/photos/Photos/Lego` -> `["Photos", "Lego"]`.
pub async fn album_page(
    State(state): State<AppState>,
    // `None` for the routes without a `*path` capture (`/`, `/photos`).
    path: Option<Path<String>>,
    Query(params): Query<AlbumViewParams>,
) -> AppResult<Markup> {
    let filters = Filters {
        min_rating: params.min_rating,
    };
    let path = path.map(|Path(p)| p).unwrap_or_default();
    let album = query::album_segments(&path);
    render(state, &album, filters).await
}

/// Render the album browsing page. `album` is `[]` for the virtual root (album
/// roots shown as tiles, no photo grid), or `["Root", "rel", …]` for a real album.
///
/// `list_subalbums` handles both; only a real album also runs a `PhotoQuery`.
async fn render(state: AppState, album: &[String], filters: Filters) -> AppResult<Markup> {
    let q = (!album.is_empty()).then(|| PhotoQuery {
        album: album.to_vec(),
        recursive: false,
        tags: Vec::new(),
        min_rating: filters.min_rating,
        // No real pagination in this first cut; list everything in the album.
        limit: u64::MAX,
        offset: 0,
    });

    // Fetch the (optional) photo page and the sub-album tiles on one connection.
    let album_for_subs = album.to_vec();
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

    // The photo grid + count line, present only for a real album.
    let grid = match &page {
        None => html! {},
        Some(page) => {
            let groups = group_by_day(&page.items);
            html! {
                p.count { (page.total) " photo(s)" }
                @if page.items.is_empty() {
                    p { "No photos in this album." }
                } @else {
                    @for (day, photos) in &groups {
                        h2 { (day) }
                        div.grid {
                            @for photo in photos {
                                @let src = format!("/api/photos/{}/file", photo.id);
                                @if photo.is_video {
                                    // Placeholder tile (▶ badge via CSS); nothing
                                    // is fetched until it's opened in the lightbox.
                                    button.vtile data-src=(src) title=(photo.name) {}
                                } @else {
                                    // Originals are full-size, so load lazily.
                                    img src=(src) alt=(photo.name) loading="lazy";
                                }
                            }
                        }
                    }
                }
            }
        }
    };

    let title = if album.is_empty() {
        "Photos".to_string()
    } else {
        format!("/{}", album.join("/"))
    };
    let body = html! { (render_subalbums(album, &subalbums, &filters)) (grid) };
    Ok(page_html(
        &title,
        breadcrumb(album, &filters),
        rating_selector(album, &filters),
        body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build album segments from string literals.
    fn segs(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn builds_breadcrumb() {
        let html = breadcrumb(&segs(&["Photos", "Lego", "Porsche911"]), &Filters::default())
            .into_string();
        assert!(html.contains("<a href=\"/photos/Photos\">Photos</a>"));
        assert!(html.contains("<a href=\"/photos/Photos/Lego\">Lego</a>"));
        assert!(html.contains("<a href=\"/photos/Photos/Lego/Porsche911\">Porsche911</a>"));
    }

    #[test]
    fn breadcrumb_encodes_and_escapes() {
        // Spaces are percent-encoded in the href; the label stays human-readable.
        let html = breadcrumb(&segs(&["My Photos"]), &Filters::default()).into_string();
        assert!(html.contains("href=\"/photos/My%20Photos\""));
        assert!(html.contains(">My Photos</a>"));
    }

    #[test]
    fn filters_propagate_into_links() {
        let f = Filters {
            min_rating: Rating::new(3).unwrap(),
        };
        // Breadcrumb links carry the active filter.
        let html = breadcrumb(&segs(&["Photos", "Lego"]), &f).into_string();
        assert!(html.contains("href=\"/photos/Photos/Lego?min_rating=3\""));
    }

    #[test]
    fn rating_selector_toggles_and_fills() {
        let html = rating_selector(
            &segs(&["Photos", "Lego"]),
            &Filters {
                min_rating: Rating::new(2).unwrap(),
            },
        )
        .into_string();
        // First two stars filled (on), and clicking star 2 again clears the filter.
        assert_eq!(html.matches("class=\"on\"").count(), 2);
        assert!(html.contains("href=\"/photos/Photos/Lego\" title=\"≥2 stars\""));
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
