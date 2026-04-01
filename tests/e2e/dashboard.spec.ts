import { test, expect } from '@playwright/test';

test.describe('ArtifactEvo Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate and wait for Preact SPA to hydrate (loads from CDN)
    await page.goto('/', { waitUntil: 'networkidle' });
    // Wait for the app to render (Preact hydrates into #app)
    await page.waitForSelector('header h1', { timeout: 15000 });
  });

  test('loads and shows overview tab', async ({ page }) => {
    await expect(page.locator('header h1')).toContainText('ArtifactEvo');
    // Overview tab should be active by default
    await expect(page.locator('nav button.active')).toContainText('Overview');
    // Should show stat cards
    await expect(page.locator('.cards .card').first()).toBeVisible();
  });

  test('navigates between all tabs', async ({ page }) => {
    const tabs = ['Overview', 'Artifacts', 'Evolution', 'Traces', 'Settings'];
    for (const tab of tabs) {
      await page.locator(`nav button`, { hasText: tab }).click();
      await expect(page.locator('nav button.active')).toContainText(tab);
    }
  });

  test('artifacts tab shows table structure', async ({ page }) => {
    await page.locator('nav button', { hasText: 'Artifacts' }).click();
    // Should show the artifacts table with headers
    await expect(page.locator('table')).toBeVisible();
    await expect(page.locator('table th').first()).toContainText('Name');
  });

  test('settings tab shows LLM provider form', async ({ page }) => {
    await page.locator('nav button', { hasText: 'Settings' }).click();
    // Should show provider dropdown
    await expect(page.locator('select').first()).toBeVisible();
    // Should show Save button
    await expect(page.locator('button', { hasText: 'Save' })).toBeVisible();
  });

  test('settings tab can change provider', async ({ page }) => {
    await page.locator('nav button', { hasText: 'Settings' }).click();
    // Wait for settings to render
    await expect(page.locator('select').first()).toBeVisible();
    // Change provider to openai
    await page.locator('select').first().selectOption('openai');
    // Form should still be visible with save button
    await expect(page.locator('button', { hasText: 'Save' })).toBeVisible();
  });

  test('overview shows correct stats from fixture data', async ({ page }) => {
    // Should show at least 1 artifact in the stat cards
    const firstCardValue = page.locator('.cards .card .value').first();
    await expect(firstCardValue).toBeVisible();
    await expect(firstCardValue).toContainText('1');
  });
});
