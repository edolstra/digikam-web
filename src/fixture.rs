//! Synthetic test-fixture seeding, shared by the API integration tests
//! ([`crate::tests`]) and the Playwright e2e suite (via the hidden
//! `--seed-fixture` flag, see [`crate::config::Config`]). Keeping one seeder
//! means the two test layers can't drift apart.
//!
//! The data is deliberately fake and small but exercises every query path:
//! multiple albums (root + nested), images vs a video, rated / unrated /
//! trashed / obsolete items, a hierarchical tag tree with its `TagsTree`
//! closure, an internal (excluded) tag, comments, and a GPS position. IDs:
//! - Albums: 1 `/`, 2 `/Animals`, 3 `/Animals/Cats`, 4 `/Beach`.
//! - Images: 100 (5★ landscape, real file + thumbnail), 101 (3★ portrait),
//!   102 (video), 103 (unrated, in /Beach), 104 (trashed), 105 (obsolete),
//!   106 (the "detail" image: 4★ square in /Beach, comments + GPS + tags beach &
//!   internal), 107 (2★, tagged sunset, in /Animals).
//! - Tags: 1 internal root + 2 internal-child; 10 places > 11 beach > 12 sunset.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::Connection;

/// The visible images' paths relative to the album-root base, written as real
/// files by [`seed`] so `/file` (and the grid's thumbnail-decode fallback)
/// serves something a browser can render. Each is a small "photo-like" JPEG
/// (sky / sun / ground scene, labeled with its file name, distinct colors,
/// aspect matching its DB dimensions — generated with ImageMagick, embedded
/// from [src/assets/fixture/](assets/fixture/)), so e2e screenshots read as
/// real loaded photos and each item is recognizable. `clip001.mp4` gets a JPEG
/// too — the file only needs to exist; the e2e tests never play it.
const IMAGE_FILES: &[(&str, &[u8])] = &[
    (
        "Animals/img001.jpg",
        include_bytes!("assets/fixture/img001.jpg"),
    ),
    (
        "Animals/clip001.mp4",
        include_bytes!("assets/fixture/clip001.jpg"),
    ),
    (
        "Animals/tagged.jpg",
        include_bytes!("assets/fixture/tagged.jpg"),
    ),
    (
        "Animals/Cats/img002.jpg",
        include_bytes!("assets/fixture/img002.jpg"),
    ),
    (
        "Beach/img003.jpg",
        include_bytes!("assets/fixture/img003.jpg"),
    ),
    (
        "Beach/detail.jpg",
        include_bytes!("assets/fixture/detail.jpg"),
    ),
];

/// Seed a complete on-disk fixture into `dir` (created if needed): a
/// `digikam4.db` + `thumbnails-digikam.db` (the default names, so only
/// `--database` needs pointing here) and a `root/` album tree with a real
/// photo-like JPEG for every visible image. Used by `--seed-fixture` for the
/// e2e suite.
pub fn seed(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let root = dir.join("root");
    let root_str = root
        .to_str()
        .context("fixture dir is not valid UTF-8")?
        .to_owned();

    let conn = Connection::open(dir.join("digikam4.db")).context("creating digikam4.db")?;
    seed_main(&conn, &root_str);
    let conn =
        Connection::open(dir.join("thumbnails-digikam.db")).context("creating thumbnails db")?;
    seed_thumbs(&conn);

    for (rel, bytes) in IMAGE_FILES {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("file path has a parent"))
            .with_context(|| format!("creating {}", path.display()))?;
        std::fs::write(&path, bytes).with_context(|| format!("writing {}", path.display()))?;
    }
    Ok(())
}

/// Create the minimal Digikam schema and seed the synthetic fixture (see the
/// module docs for the data's shape).
pub fn seed_main(conn: &Connection, root_base: &str) {
    conn.execute_batch(
        "CREATE TABLE AlbumRoots(id INTEGER PRIMARY KEY, label TEXT, identifier TEXT, specificPath TEXT);
         -- The UNIQUE constraints are Digikam's own (so the tests see the same
         -- conflicts a real collection would raise).
         CREATE TABLE Albums(id INTEGER PRIMARY KEY, albumRoot INTEGER, relativePath TEXT,
                             UNIQUE (albumRoot, relativePath));
         CREATE TABLE Images(id INTEGER PRIMARY KEY, album INTEGER, name TEXT, status INTEGER,
                             fileSize INTEGER, uniqueHash TEXT, modificationDate TEXT, category INTEGER,
                             UNIQUE (album, name));
         CREATE TABLE ImageInformation(imageid INTEGER PRIMARY KEY, rating INTEGER, creationDate TEXT,
                             width INTEGER, height INTEGER, format TEXT);
         CREATE TABLE ImageComments(id INTEGER PRIMARY KEY, imageid INTEGER, type INTEGER, language TEXT, comment TEXT);
         CREATE TABLE ImagePositions(imageid INTEGER PRIMARY KEY, latitudeNumber REAL, longitudeNumber REAL);
         CREATE TABLE Tags(id INTEGER PRIMARY KEY, pid INTEGER, name TEXT);
         CREATE TABLE TagsTree(id INTEGER, pid INTEGER);
         CREATE TABLE ImageTags(imageid INTEGER, tagid INTEGER);

         INSERT INTO Albums(id, albumRoot, relativePath) VALUES
           (1, 1, '/'), (2, 1, '/Animals'), (3, 1, '/Animals/Cats'), (4, 1, '/Beach');

         -- status 1 = visible; 3 = trashed, 4 = obsolete (both must be excluded).
         -- category 2 = video. modificationDate drives ordering (newest first).
         INSERT INTO Images(id, album, name, status, fileSize, uniqueHash, modificationDate, category) VALUES
           (100, 2, 'img001.jpg',  1, 1000, 'hash100', '2024-01-05T10:00:00', 1),
           (101, 3, 'img002.jpg',  1, 2000, 'hash101', '2024-01-04T10:00:00', 1),
           (102, 2, 'clip001.mp4', 1, 3000, 'hash102', '2024-01-03T10:00:00', 2),
           (103, 4, 'img003.jpg',  1, 4000, 'hash103', '2024-01-02T10:00:00', 1),
           (104, 2, 'trashed.jpg', 3, 5000, 'hash104', '2024-01-07T10:00:00', 1),
           (105, 2, 'obsol.jpg',   4, 5500, 'hash105', '2024-01-08T10:00:00', 1),
           (106, 4, 'detail.jpg',  1, 6000, 'hash106', '2024-01-06T10:00:00', 1),
           (107, 2, 'tagged.jpg',  1, 7000, 'hash107', '2024-01-01T10:00:00', 1);

         -- rating -1 = unrated. Dimensions drive the aspect filter.
         INSERT INTO ImageInformation(imageid, rating, creationDate, width, height, format) VALUES
           (100,  5, '2023-12-01T09:00:00', 4000, 3000, 'JPG'),
           (101,  3, '2023-12-02T09:00:00', 3000, 4000, 'JPG'),
           (102,  0, '2023-12-03T09:00:00', 1920, 1080, 'MP4'),
           (103, -1, '2023-12-04T09:00:00', 4000, 3000, 'JPG'),
           (106,  4, '2023-11-15T08:30:00', 3000, 3000, 'JPG'),
           (107,  2, '2023-12-05T09:00:00', 4000, 3000, 'JPG');

         -- Two comments on image 106 -> newline-joined description.
         INSERT INTO ImageComments(id, imageid, type, language, comment) VALUES
           (1, 106, 1, 'x-default', 'caption one'),
           (2, 106, 1, 'x-default', 'caption two');

         INSERT INTO ImagePositions(imageid, latitudeNumber, longitudeNumber) VALUES
           (106, 12.34, 56.78);

         -- Tag 1 is Digikam's reserved internal root (excluded everywhere); 2 is a
         -- child of it. 10/11/12 are a normal hierarchy /places/beach/sunset.
         INSERT INTO Tags(id, pid, name) VALUES
           (1, 0, '_Digikam_Internal_Tags_'), (2, 1, 'internal-child'),
           (10, 0, 'places'), (11, 10, 'beach'), (12, 11, 'sunset');

         -- TagsTree(id, pid): id is a strict descendant of pid (closure).
         INSERT INTO TagsTree(id, pid) VALUES
           (2, 1), (11, 10), (12, 11), (12, 10);

         INSERT INTO ImageTags(imageid, tagid) VALUES
           (106, 11), (106, 2), (107, 12);",
    )
    .expect("seed main schema");

    conn.execute(
        "INSERT INTO AlbumRoots(id, label, identifier, specificPath) \
         VALUES (1, 'Collection', ?1, '/')",
        [format!("volumeid:?path={root_base}&fileuuid=test")],
    )
    .expect("seed album root");
}

/// Seed the thumbnails DB: one cached thumbnail for image 100 (keyed by its
/// uniqueHash + fileSize), with an orientation hint. The blob is junk (not
/// PGF), so the web client's decode fails and falls back to `/file` — itself a
/// path worth exercising.
pub fn seed_thumbs(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE UniqueHashes(uniqueHash TEXT, fileSize INTEGER, thumbId INTEGER);
         CREATE TABLE Thumbnails(id INTEGER PRIMARY KEY, data BLOB, orientationHint INTEGER);
         INSERT INTO Thumbnails(id, data, orientationHint) VALUES (1, x'0102030405', 6);
         INSERT INTO UniqueHashes(uniqueHash, fileSize, thumbId) VALUES ('hash100', 1000, 1);",
    )
    .expect("seed thumbs");
}
