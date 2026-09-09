// Basic smoke tests: the SPA renders the album grid, and clicking a photo
// opens it full-screen in the lightbox. The data is the synthetic fixture from
// src/fixture.rs: album /Collection/Animals holds images 100 (img001.jpg) and
// 107 (tagged.jpg) plus video 102 (clip001.mp4), each on its own day.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const ALBUM = '/photos/Collection/Animals';
// The lightbox's "open" and "slideshow running" classes. Not `\bopen\b` /
// `\bslideshow\b`: `-` is a word boundary, so those also match `info-open` /
// `slideshow-open` (the info panel / the settings modal).
const OPEN = /(^|\s)open(\s|$)/;
const RUNNING = /(^|\s)slideshow(\s|$)/;

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
  await expect(lb).toHaveClass(OPEN);
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
  await expect(lb).not.toHaveClass(OPEN);
  await expect(lb).toBeHidden();
  await shot(page, '04-lightbox-dismissed');
});

test('autoplay=true opens the lightbox in slideshow mode', async ({ page }) => {
  // Images only, so the slideshow can't land on the video (whose unprompted
  // play() is subject to the autoplay policy). `interval=1` shortens the
  // default 5s image interval so the advance is observable quickly;
  // `shuffle=false` makes it start at the first grid item and walk in order.
  await page.goto(ALBUM + '?video=false&autoplay=true&interval=1&shuffle=false');

  const lb = page.locator('#lightbox');
  await expect(lb).toHaveClass(OPEN);
  await expect(lb).toHaveClass(RUNNING);
  await expect(lb.locator('.slideshow-btn')).toHaveText('⏸');
  const img = page.locator('#lb-img');
  // Grid order under the default sort is [100, 107]: unshuffled, it starts at 100.
  await expect(img).toHaveAttribute('src', /\/api\/photos\/100\/file$/);
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  await shot(page, '05-autoplay-slideshow');

  // The slideshow advances on its own, in grid order: to 107 within the (1s)
  // interval, well inside the poll timeout.
  await expect(img).toHaveAttribute('src', /\/api\/photos\/107\/file$/, { timeout: 4000 });

  // A page load carries no user gesture, so the browser refuses fullscreen at
  // that point; the first key press stands in for it.
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() =>
      page.evaluate(() => document.fullscreenElement && document.fullscreenElement.id)
    )
    .toBe('lightbox');
  await expect(lb).toHaveClass(RUNNING); // the key press didn't stop it

  // The autoplay pushed the usual lightbox history entry: Back dismisses it and
  // lands on the album grid, not off the site.
  await page.goBack();
  await expect(lb).not.toHaveClass(OPEN);
  await expect(page.locator('#photos .grid > img.thumb')).toHaveCount(2);
});

// The lightbox controls auto-hide (`.idle`, pointer-events: none) 2s after the
// last mouse move, and Playwright won't click through that: reveal them first.
async function wakeControls(page) {
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 310);
  await expect(page.locator('#lightbox')).not.toHaveClass(/\bidle\b/);
}

test('the ▶ button opens the slideshow settings modal', async ({ page }) => {
  await page.goto(ALBUM + '?video=false');
  await page.locator('#item-100').click();
  const lb = page.locator('#lightbox');
  await expect(lb).toHaveClass(OPEN);
  const panel = page.locator('#lb-slideshow');
  const img = page.locator('#lb-img');

  // ▶ opens the modal; it does not start anything.
  await wakeControls(page);
  await page.locator('.slideshow-btn').click();
  await expect(lb).toHaveClass(/\bslideshow-open\b/);
  await expect(panel).toBeVisible();
  await expect(lb).not.toHaveClass(RUNNING);
  await expect(panel.locator('.ss-interval')).toHaveValue('5');
  await expect(panel.locator('.ss-shuffle button.on')).toHaveText('On');
  // Modal: the UI stays pinned (no auto-hide) while it's open.
  await page.waitForTimeout(2500);
  await expect(lb).not.toHaveClass(/\bidle\b/);

  // Shuffle Off keeps the modal open; Enter in the number box starts the
  // slideshow with the typed interval and closes the modal.
  await panel.locator('.ss-shuffle button[data-shuffle="false"]').click();
  await expect(panel.locator('.ss-shuffle button.on')).toHaveText('Off');
  await expect(lb).toHaveClass(/\bslideshow-open\b/);
  await shot(page, '06-slideshow-settings');
  await panel.locator('.ss-interval').fill('1');
  await panel.locator('.ss-interval').press('Enter');
  await expect(lb).toHaveClass(RUNNING);
  await expect(lb).not.toHaveClass(/\bslideshow-open\b/);
  await expect(lb.locator('.slideshow-btn')).toHaveText('⏸');
  // Grid order is [100, 107]: from 100 it advances to 107, then wraps to 100.
  await expect(img).toHaveAttribute('src', /\/api\/photos\/107\/file$/, { timeout: 4000 });
  await expect(img).toHaveAttribute('src', /\/api\/photos\/100\/file$/, { timeout: 4000 });

  // `s` stops / starts directly, never opening the modal.
  await page.keyboard.press('s');
  await expect(lb).not.toHaveClass(RUNNING);
  await page.keyboard.press('s');
  await expect(lb).toHaveClass(RUNNING);
  await expect(lb).not.toHaveClass(/\bslideshow-open\b/);
  await page.keyboard.press('s');
  await expect(lb).not.toHaveClass(RUNNING);

  // Copy slideshow link: the current view + the launch settings — and nothing
  // of that in the page's own URL. Capture the clipboard write in-page (no
  // clipboard permission needed).
  await page.evaluate(() => {
    navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
  });
  await wakeControls(page);
  await page.locator('.slideshow-btn').click();
  await expect(lb).toHaveClass(/\bslideshow-open\b/);
  await panel.locator('.ss-copy').click();
  await expect(panel.locator('.ss-copy')).toHaveClass(/\bcopied\b/);
  const copied = new URL(await page.evaluate(() => window.__copied));
  expect(copied.pathname).toBe('/photos/Collection/Animals');
  expect(copied.searchParams.get('video')).toBe('false');
  expect(copied.searchParams.get('autoplay')).toBe('true');
  expect(copied.searchParams.get('interval')).toBe('1');
  expect(copied.searchParams.get('shuffle')).toBe('false');
  for (const p of ['autoplay', 'interval', 'shuffle']) expect(page.url()).not.toContain(p);

  // A click outside closes the modal and does nothing else: ⓘ does not open.
  await page.locator('#lightbox .info').click();
  await expect(lb).not.toHaveClass(/\bslideshow-open\b/);
  await expect(lb).not.toHaveClass(/\binfo-open\b/);
  // The modal overlays an open info panel rather than excluding it.
  await page.keyboard.press('i');
  await expect(lb).toHaveClass(/\binfo-open\b/);
  await page.locator('.slideshow-btn').click();
  await expect(lb).toHaveClass(/\bslideshow-open\b/);
  await expect(lb).toHaveClass(/\binfo-open\b/);
  await shot(page, '07-slideshow-settings-over-info');

  // Esc closes the modal first, then the lightbox.
  await page.keyboard.press('Escape');
  await expect(lb).not.toHaveClass(/\bslideshow-open\b/);
  await expect(lb).toHaveClass(OPEN);
  await page.keyboard.press('Escape');
  await expect(lb).not.toHaveClass(OPEN);
});
