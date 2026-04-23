import { test, expect } from '@playwright/test';

test('Login page validation', async ({ page }) => {
  await page.goto('http://localhost:5173/login');

  // Test empty email validation
  await page.fill('input[type="password"]', '123456');
  await page.click('button[type="submit"]');
  await expect(page.locator('text=Email is required')).toBeVisible();

  // Test password length validation
  await page.fill('input[type="email"]', 'test@example.com');
  await page.fill('input[type="password"]', '123');
  await page.click('button[type="submit"]');
  await expect(page.locator('text=Password must be at least 6 characters')).toBeVisible();

  // Test successful login
  await page.fill('input[type="email"]', 'test@example.com');
  await page.fill('input[type="password"]', '123456');
  await page.click('button[type="submit"]');
  await expect(page.locator('text=Email is required')).not.toBeVisible();
  await expect(page.locator('text=Password must be at least 6 characters')).not.toBeVisible();
});