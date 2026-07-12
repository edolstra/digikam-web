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

/// A real (decodable) 64×48 JPEG, ~370 bytes, so a browser driven by the e2e
/// tests renders actual pixels (`naturalWidth > 0`) from `/file`.
pub const TINY_JPEG: &[u8] = &[
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x0d, 0x09, 0x0a, 0x0b, 0x0a, 0x08, 0x0d,
    0x0b, 0x0a, 0x0b, 0x0e, 0x0e, 0x0d, 0x0f, 0x13, 0x20, 0x15, 0x13, 0x12, 0x12, 0x13, 0x27, 0x1c,
    0x1e, 0x17, 0x20, 0x2e, 0x29, 0x31, 0x30, 0x2e, 0x29, 0x2d, 0x2c, 0x33, 0x3a, 0x4a, 0x3e, 0x33,
    0x36, 0x46, 0x37, 0x2c, 0x2d, 0x40, 0x57, 0x41, 0x46, 0x4c, 0x4e, 0x52, 0x53, 0x52, 0x32, 0x3e,
    0x5a, 0x61, 0x5a, 0x50, 0x60, 0x4a, 0x51, 0x52, 0x4f, 0xff, 0xdb, 0x00, 0x43, 0x01, 0x0e, 0x0e,
    0x0e, 0x13, 0x11, 0x13, 0x26, 0x15, 0x15, 0x26, 0x4f, 0x35, 0x2d, 0x35, 0x4f, 0x4f, 0x4f, 0x4f,
    0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f,
    0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f,
    0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0x4f, 0xff, 0xc0,
    0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11,
    0x01, 0xff, 0xc4, 0x00, 0x15, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0xff, 0xc4, 0x00, 0x16, 0x10, 0x01, 0x01, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x13, 0x61,
    0xff, 0xc4, 0x00, 0x16, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x05, 0xff, 0xc4, 0x00, 0x16, 0x11, 0x01, 0x01, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11, 0x12,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0x92, 0x85,
    0x12, 0x50, 0xa3, 0x5f, 0x2c, 0xe8, 0xae, 0x85, 0x12, 0x50, 0xa1, 0x92, 0x2b, 0xa1, 0x44, 0x94,
    0x28, 0x64, 0x8a, 0xe8, 0x51, 0x25, 0x0a, 0x19, 0x22, 0x4a, 0x69, 0x4d, 0x4b, 0x42, 0x8a, 0xe5,
    0x48, 0xaa, 0x9a, 0x53, 0x52, 0xd0, 0xa1, 0x92, 0x2a, 0xa6, 0x94, 0xd4, 0xb4, 0x28, 0x64, 0x8a,
    0xa9, 0xa5, 0x35, 0x2d, 0x0a, 0x19, 0x22, 0x4a, 0x14, 0x49, 0x42, 0x8b, 0x65, 0x58, 0xae, 0x85,
    0x12, 0x50, 0xa1, 0x92, 0x2b, 0xa1, 0x44, 0x94, 0x28, 0x64, 0x8a, 0xe8, 0x51, 0x25, 0x0a, 0x19,
    0x23, 0xff, 0xd9,
];

/// The visible images' paths relative to the album-root base, written as real
/// files by [`seed`] so `/file` (and the grid's thumbnail-decode fallback)
/// serves something a browser can render. `clip001.mp4` gets the same bytes —
/// it only needs to exist; the e2e tests never play it.
const IMAGE_FILES: &[&str] = &[
    "Animals/img001.jpg",
    "Animals/clip001.mp4",
    "Animals/tagged.jpg",
    "Animals/Cats/img002.jpg",
    "Beach/img003.jpg",
    "Beach/detail.jpg",
];

/// Seed a complete on-disk fixture into `dir` (created if needed): a
/// `digikam4.db` + `thumbnails-digikam.db` (the default names, so only
/// `--database` needs pointing here) and a `root/` album tree with a real tiny
/// JPEG for every visible image. Used by `--seed-fixture` for the e2e suite.
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

    for rel in IMAGE_FILES {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("file path has a parent"))
            .with_context(|| format!("creating {}", path.display()))?;
        std::fs::write(&path, TINY_JPEG).with_context(|| format!("writing {}", path.display()))?;
    }
    Ok(())
}

/// Create the minimal Digikam schema and seed the synthetic fixture (see the
/// module docs for the data's shape).
pub fn seed_main(conn: &Connection, root_base: &str) {
    conn.execute_batch(
        "CREATE TABLE AlbumRoots(id INTEGER PRIMARY KEY, label TEXT, identifier TEXT, specificPath TEXT);
         CREATE TABLE Albums(id INTEGER PRIMARY KEY, albumRoot INTEGER, relativePath TEXT);
         CREATE TABLE Images(id INTEGER PRIMARY KEY, album INTEGER, name TEXT, status INTEGER,
                             fileSize INTEGER, uniqueHash TEXT, modificationDate TEXT, category INTEGER);
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
