// Go to album (`g`): the Move modal's album picker, used for navigation.
// Fixture (src/fixture.rs): albums /Collection/{Animals, Animals/Cats, Beach};
// Beach holds image 103.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const OPEN = /(^|\s)open(\s|$)/;

const SHOT_DIR =
  process.env.E2E_SCREENSHOT_DIR || path.join(__dirname, 'test-results', 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
function shot(page, name) {
  return page.screenshot({ path: path.join(SHOT_DIR, name + '.png') });
}

test('g jumps to an album, sharing the recently used list with Move', async ({ page }) => {
  await page.goto('/photos/Collection/Animals?video=false');
  await expect(page.locator('#item-100')).toBeVisible();
  const picker = page.locator('#picker');
  const lb = page.locator('#lightbox');
  const mru = picker.locator('.picker-mru .picker-row');

  // The album tree, the current album highlighted; no Apply button.
  await page.keyboard.press('g');
  await expect(picker).toHaveClass(OPEN);
  await expect(picker.locator('.picker-label-list')).toHaveText('Go to album');
  await expect(picker.locator('.picker-list .picker-row.current')).toHaveText('Animals');
  await expect(picker.locator('.picker-apply')).toBeHidden();
  await expect(mru).toHaveCount(0);
  await shot(page, 'picker-goto');

  // Type-and-Enter goes to the first match, keeping the filters.
  await page.keyboard.type('beach');
  await page.keyboard.press('Enter');
  await expect(picker).not.toHaveClass(OPEN);
  await expect(page).toHaveURL(/\/photos\/Collection\/Beach\?video=false$/);
  await expect(page.locator('#item-103')).toBeVisible();

  // It's now recently used, and the current album.
  await page.keyboard.press('g');
  await expect(mru).toHaveText(['/Collection/Beach']);
  await expect(picker.locator('.picker-list .picker-row.current')).toHaveText('Beach');
  await page.keyboard.press('Escape');
  await expect(picker).not.toHaveClass(OPEN);

  // Move's recently used list is the same one.
  await page.locator('#item-103').click();
  await expect(lb).toHaveClass(OPEN);
  await page.keyboard.press('v');
  await expect(picker.locator('.picker-label-list')).toHaveText('Albums');
  await expect(mru).toHaveText(['/Collection/Beach']);
  await page.keyboard.press('Escape');
  await expect(picker).not.toHaveClass(OPEN);

  // From the lightbox: closes it and goes there; Back returns.
  await page.keyboard.press('g');
  await expect(picker.locator('.picker-label-list')).toHaveText('Go to album');
  await picker.locator('.picker-list .picker-row[data-path="/Collection/Animals"]').click();
  await expect(picker).not.toHaveClass(OPEN);
  await expect(lb).not.toHaveClass(OPEN);
  await expect(page).toHaveURL(/\/photos\/Collection\/Animals\?video=false$/);
  await expect(page.locator('#item-100')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/photos\/Collection\/Beach\?video=false/);
  await expect(page.locator('#item-103')).toBeVisible();

  // Most recent last.
  await page.keyboard.press('g');
  await expect(mru).toHaveText(['/Collection/Beach', '/Collection/Animals']);
  await page.keyboard.press('Escape');
  await expect(picker).not.toHaveClass(OPEN);

  // The navbar's folder button opens it too.
  await page.locator('.navbar .goto-btn').click();
  await expect(picker).toHaveClass(OPEN);
  await expect(picker.locator('.picker-label-list')).toHaveText('Go to album');
  await expect(page.locator('#picker-filter')).toBeFocused();
  await picker.locator('.picker-list .picker-row[data-path="/Collection/Animals/Cats"]').click();
  await expect(page).toHaveURL(/\/photos\/Collection\/Animals\/Cats\?video=false$/);
  await shot(page, 'navbar-goto-button');
});
