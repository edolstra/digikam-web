// Basic smoke tests: the SPA renders the album grid, and clicking a photo
// opens it full-screen in the lightbox. The data is the synthetic fixture from
// src/fixture.rs: album /Collection/Animals holds images 100 (img001.jpg) and
// 107 (tagged.jpg) plus video 102 (clip001.mp4), each on its own day.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const ALBUM = '/photos/Collection/Animals';

// Full-page screenshots at each interesting stage, for human inspection. The
// flake's e2e check points $E2E_SCREENSHOT_DIR at its $out, so
// `nix build .#checks.<system>.e2e` leaves a ./result full of screenshots.
const SHOT_DIR =
  process.env.E2E_SCREENSHOT_DIR || path.join(__dirname, 'test-results', 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
function shot(page, name) {
  return page.screenshot({ path: path.join(SHOT_DIR, name + '.png') });
}

test('root page lists the album roots', async ({ page }) => {
  await page.goto('/photos');
  const tiles = page.locator('.albums > a.album');
  await expect(tiles).toHaveCount(1);
  await expect(tiles.locator('.title')).toHaveText('Collection');
  // The root tile's cover goes through the same lazy pipeline; let it paint
  // before the screenshot.
  await expect
    .poll(() => tiles.locator('img.thumb').evaluate((el) => el.naturalWidth))
    .toBeGreaterThan(0);
  await shot(page, '01-root-albums');
});

test('photo grid loads and paints real images', async ({ page }) => {
  await page.goto(ALBUM);
  await expect(page.locator('#photos .count')).toHaveText('3 photo(s) or video(s)');
  // Day-grouped grid (default `modified` sort): three items on three days.
  await expect(page.locator('#photos .grid > img.thumb')).toHaveCount(2);
  await expect(page.locator('#photos .grid > .vtile')).toHaveCount(1);
  await expect(page.locator('#photos h2').first()).toHaveText('2024-01-05');
  // The tiles paint real pixels: image 100's stored thumbnail is junk PGF, so
  // the decode fails and the pipeline falls back to the full-size /file (a
  // real JPEG in the fixture).
  const tile = page.locator('#item-100');
  await expect.poll(() => tile.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('#item-107').evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  await shot(page, '02-album-grid');
});

test('clicking a photo opens it full-screen in the lightbox', async ({ page }) => {
  await page.goto(ALBUM);
  await page.locator('#item-100').click();

  const lb = page.locator('#lightbox');
  await expect(lb).toHaveClass(/\bopen\b/);
  await expect(lb).toBeVisible();
  const img = page.locator('#lb-img');
  await expect(img).toHaveAttribute('src', /\/api\/photos\/100\/file$/);
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);

  // Opening requests browser fullscreen on the lightbox element (the click
  // carries the required user activation, also in headless Chromium).
  await expect
    .poll(() =>
      page.evaluate(() => document.fullscreenElement && document.fullscreenElement.id)
    )
    .toBe('lightbox');
  await shot(page, '03-lightbox-fullscreen');

  // Esc exits fullscreen and (tab focused + visible) dismisses the lightbox.
  await page.keyboard.press('Escape');
  await expect(lb).not.toHaveClass(/\bopen\b/);
  await expect(lb).toBeHidden();
  await shot(page, '04-lightbox-dismissed');
});

test('autoplay=true opens the lightbox in slideshow mode', async ({ page }) => {
  // Images only, so the random start can't land on the video (whose unprompted
  // play() is subject to the autoplay policy).
  await page.goto(ALBUM + '?video=false&autoplay=true');

  const lb = page.locator('#lightbox');
  await expect(lb).toHaveClass(/\bopen\b/);
  await expect(lb).toHaveClass(/\bslideshow\b/);
  await expect(lb.locator('.slideshow-btn')).toHaveText('⏸');
  const img = page.locator('#lb-img');
  await expect(img).toHaveAttribute('src', /\/api\/photos\/(100|107)\/file$/);
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  await shot(page, '05-autoplay-slideshow');

  // A page load carries no user gesture, so the browser refuses fullscreen at
  // that point; the first key press stands in for it.
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() =>
      page.evaluate(() => document.fullscreenElement && document.fullscreenElement.id)
    )
    .toBe('lightbox');
  await expect(lb).toHaveClass(/\bslideshow\b/); // the key press didn't stop it

  // The autoplay pushed the usual lightbox history entry: Back dismisses it and
  // lands on the album grid, not off the site.
  await page.goBack();
  await expect(lb).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#photos .grid > img.thumb')).toHaveCount(2);
});
