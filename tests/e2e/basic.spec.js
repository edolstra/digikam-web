// Basic smoke tests: the SPA renders the album grid, and clicking a photo
// opens it full-screen in the lightbox. The data is the synthetic fixture from
// src/fixture.rs: album /Collection/Animals holds images 100 (img001.jpg) and
// 107 (tagged.jpg) plus video 102 (clip001.mp4), each on its own day.
const { test, expect } = require('@playwright/test');

const ALBUM = '/photos/Collection/Animals';

test('root page lists the album roots', async ({ page }) => {
  await page.goto('/photos');
  const tiles = page.locator('.albums > a.album');
  await expect(tiles).toHaveCount(1);
  await expect(tiles.locator('.title')).toHaveText('Collection');
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

  // Esc exits fullscreen and (tab focused + visible) dismisses the lightbox.
  await page.keyboard.press('Escape');
  await expect(lb).not.toHaveClass(/\bopen\b/);
  await expect(lb).toBeHidden();
});
