// Selection mode: checking several grid items and tagging / moving them
// together. Fixture (src/fixture.rs): album /Collection/Animals holds images
// 100 (img001.jpg, untagged) and 107 (tagged.jpg, /places/beach/sunset) plus
// video 102; grid order (newest first) is [100, 102, 107]. Tests that write
// undo their changes, as the server is shared by the whole suite.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const ALBUM = '/photos/Collection/Animals';
const OPEN = /(^|\s)open(\s|$)/;
const SELECT_MODE = /(^|\s)select-mode(\s|$)/;

const SHOT_DIR =
  process.env.E2E_SCREENSHOT_DIR || path.join(__dirname, 'test-results', 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
function shot(page, name) {
  return page.screenshot({ path: path.join(SHOT_DIR, name + '.png') });
}

// Hold the mouse down on the middle of `selector` for longer than a long press.
async function longPress(page, selector) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
}

async function photo(request, id) {
  const r = await request.get(`/api/photos/${id}`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}

test('a long press enters selection mode; the checks outlive leaving it', async ({ page }) => {
  await page.goto(ALBUM);
  const body = page.locator('body');
  const lb = page.locator('#lightbox');
  const checkedTiles = page.locator('#photos .tile.checked');

  // The long press checks the item and doesn't open the lightbox.
  await longPress(page, '#item-100');
  await expect(body).toHaveClass(SELECT_MODE);
  await expect(page.locator('#item-100')).toHaveClass(/\bchecked\b/);
  await expect(lb).not.toHaveClass(OPEN);
  await page.locator('#item-107 .check').click();
  await expect(page.locator('.sel-count')).toHaveText('2 selected');
  await expect(page.locator('.crumb')).toBeHidden();
  await shot(page, 'selection-mode');

  // Esc leaves the mode (the checkboxes disappear); `x` comes back to the
  // same checks.
  await page.keyboard.press('Escape');
  await expect(body).not.toHaveClass(SELECT_MODE);
  await expect(page.locator('#item-100 .check')).toBeHidden();
  await expect(page.locator('.crumb')).toBeVisible();
  await page.keyboard.press('x');
  await expect(body).toHaveClass(SELECT_MODE);
  await expect(checkedTiles).toHaveCount(2);

  // Clicking an item (not its checkbox) opens the lightbox as usual; closing
  // it returns to the grid, still in selection mode.
  await page.locator('#item-102').click();
  await expect(lb).toHaveClass(OPEN);
  await page.keyboard.press('Escape');
  await expect(lb).not.toHaveClass(OPEN);
  await expect(body).toHaveClass(SELECT_MODE);
  await expect(checkedTiles).toHaveCount(2);

  // None / Shift-click range / All.
  await page.locator('.sel-none').click();
  await expect(checkedTiles).toHaveCount(0);
  await expect(page.locator('.sel-tags')).toBeDisabled();
  await page.locator('#item-100 .check').click();
  await page.locator('#item-107 .check').click({ modifiers: ['Shift'] });
  await expect(checkedTiles).toHaveCount(3);
  await page.locator('#item-102 .check').click();
  await expect(checkedTiles).toHaveCount(2);
  await page.locator('.sel-all').click();
  await expect(page.locator('.sel-count')).toHaveText('3 selected');

  // Keyboard: Space toggles the keyboard-cursor item.
  await page.keyboard.press('End'); // the cursor to the last item (107)
  // The cursor's highlight shows on a checked (dimmed) item too.
  await expect(page.locator('#item-107')).toHaveClass(/\bselected\b/);
  await expect
    .poll(() => page.locator('#item-107').evaluate((el) => getComputedStyle(el, '::before').borderTopColor))
    .toBe('rgb(245, 197, 24)');
  await shot(page, 'selection-cursor-on-checked');
  await page.keyboard.press('Space');
  await expect(page.locator('#item-107')).not.toHaveClass(/\bchecked\b/);

  // A navigation clears the selection and leaves the mode.
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page).toHaveURL(/\/photos\/Collection$/);
  await expect(body).not.toHaveClass(SELECT_MODE);
  await page.goBack();
  await expect(page.locator('#item-100')).toBeVisible();
  await page.keyboard.press('x');
  await expect(checkedTiles).toHaveCount(0);
});

test('tagging several items: tri-state rows, one undo for the batch', async ({ page, request }) => {
  await page.goto(ALBUM + '?video=false'); // items [100, 107]
  await page.keyboard.press('x');
  await page.locator('.sel-all').click();
  await page.keyboard.press('t');

  const picker = page.locator('#picker');
  await expect(picker).toHaveClass(OPEN);
  await expect(picker.locator('.picker-label-list')).toHaveText('Tags · 2 items');
  const box = (p) => picker.locator(`.picker-list input[data-path="${p}"]`);
  const sunset = box('/places/beach/sunset');
  const beach = box('/places/beach');

  // 107 has sunset, 100 doesn't: "some", with a 1/2 count.
  await expect(sunset).toHaveJSProperty('indeterminate', true);
  const sunsetRow = picker.locator('.picker-list .picker-row', {
    has: page.locator('input[data-path="/places/beach/sunset"]'),
  });
  await expect(sunsetRow.locator('.picker-count'))
    .toHaveText('1/2');
  await expect(beach).not.toBeChecked();
  await expect(beach).toHaveJSProperty('indeterminate', false);
  await shot(page, 'picker-tags-multi');

  // A "some" row cycles some → on → off → some (back to no change).
  await sunset.click();
  await expect(sunset).toBeChecked();
  await expect(sunset).toHaveJSProperty('indeterminate', false);
  await sunset.click();
  await expect(sunset).not.toBeChecked();
  await expect(sunset).toHaveJSProperty('indeterminate', false);
  await sunset.click();
  await expect(sunset).toHaveJSProperty('indeterminate', true);
  await expect(picker.locator('.picker-apply')).toBeDisabled();

  // Add beach to both; sunset stays as it was.
  await beach.click();
  await picker.locator('.picker-apply').click();
  await expect(picker).not.toHaveClass(OPEN);
  await expect(page.locator('#toast')).toContainText('tags of 2 items: +/places/beach');
  expect((await photo(request, 100)).tags).toEqual(['/places/beach']);
  expect((await photo(request, 107)).tags).toEqual(['/places/beach', '/places/beach/sunset']);
  // The selection survives the operation.
  await expect(page.locator('.sel-count')).toHaveText('2 selected');

  // One `u` undoes it for both.
  await page.keyboard.press('u');
  await expect(page.locator('#toast')).toContainText('Undone: tags of 2 items');
  expect((await photo(request, 100)).tags).toEqual([]);
  expect((await photo(request, 107)).tags).toEqual(['/places/beach/sunset']);
});

test('a partly failed bulk tag reports it, and undo covers the rest', async ({ page, request }) => {
  await page.route(/\/api\/photos\/107$/, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, body: '{}' })
      : route.continue()
  );
  await page.goto(ALBUM + '?video=false');
  await page.keyboard.press('x');
  await page.locator('.sel-all').click();
  await page.locator('.sel-tags').click();
  const picker = page.locator('#picker');
  await picker.locator('.picker-list input[data-path="/places"]').click();
  await picker.locator('.picker-apply').click();
  await expect(picker).not.toHaveClass(OPEN);
  await expect(page.locator('#toast')).toHaveText('tags of img001.jpg: +/places (1 of 2 items failed)');
  await expect(page.locator('#toast')).toHaveClass(/\bfailed\b/);
  expect((await photo(request, 100)).tags).toEqual(['/places']);

  await page.keyboard.press('u');
  await expect(page.locator('#toast')).toContainText('Undone: tags of img001.jpg');
  expect((await photo(request, 100)).tags).toEqual([]);
});

test('moving several items, and undoing it', async ({ page, request }) => {
  await page.goto(ALBUM + '?video=false');
  await longPress(page, '#item-100');
  await page.locator('#item-107 .check').click();
  await page.locator('.sel-move').click();

  const picker = page.locator('#picker');
  await expect(picker).toHaveClass(OPEN);
  // Both are in Animals: that's the highlighted current album.
  await expect(picker.locator('.picker-list .picker-row.current')).toHaveText('Animals');
  await shot(page, 'picker-move-multi');
  await picker.locator('.picker-list .picker-row[data-path="/Collection/Beach"]').click();
  await expect(picker).not.toHaveClass(OPEN);
  await expect(page.locator('#toast')).toHaveText('moved 2 items → /Collection/Beach');
  expect((await photo(request, 100)).album_path).toBe('/Collection/Beach');
  expect((await photo(request, 107)).album_path).toBe('/Collection/Beach');

  await page.keyboard.press('u');
  await expect(page.locator('#toast')).toContainText('Undone: move of 2 items');
  expect((await photo(request, 100)).album_path).toBe('/Collection/Animals');
  expect((await photo(request, 107)).album_path).toBe('/Collection/Animals');
});
