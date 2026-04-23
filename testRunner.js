import { chromium } from "playwright";
import path from "path";
import fs from "fs";

export async function runUITest() {

  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true
  });

  const page = await browser.newPage();
  const filePath = path.resolve("./workspace/index.html");

  if (!fs.existsSync(filePath)) {
    throw new Error("index.html not found");
  }

  await page.goto("file://" + filePath);

  const text = await page.textContent("h1");

  await browser.close();

  return {
    success: text.includes("Hello AI Agent"),
    text
  };
}
