// tools/capture.js
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { WORKSPACE_ROOT, resolveWorkspacePath } from "./workspace_utils.js";
// Correct ES module import:
import { PNG } from "pngjs";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

function getReferenceViewport() {
  try {
    const refPath = path.join(WORKSPACE_ROOT, "reference_ui.png");
    if (!fs.existsSync(refPath)) return DEFAULT_VIEWPORT;

    const buf = fs.readFileSync(refPath);
    const png = PNG.sync.read(buf);  // ✔ using ES import

    if (png.width && png.height) {
      console.log(`[capture] Using reference viewport ${png.width}x${png.height}`);
      return { width: png.width, height: png.height };
    }
  } catch (err) {
    console.warn("[capture] Failed to read reference viewport:", err);
  }
  return DEFAULT_VIEWPORT;
}

export async function captureUI({ url, outPath = "current_ui.png" }) {
  if (!url || typeof url !== "string") {
    throw new Error("captureUI: 'url' is required and must be a string.");
  }

  const relOut = outPath.replace(/^\/+/, "");
  const { fullPath } = resolveWorkspacePath(relOut);

  const viewport = getReferenceViewport();

  console.log(`[capture] Launching Chrome to capture ${url} ...`);
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true
  });

  const page = await browser.newPage({
    viewport,
    deviceScaleFactor: 1
  });

  const MAX_RETRIES = 5;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 10000 });
      break;
    } catch (err) {
      if (i === MAX_RETRIES - 1) {
        await browser.close();
        return { success: false, path: fullPath, error: err.message };
      }
      console.warn(`[capture] Retry ${i + 1}/${MAX_RETRIES}...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  try {
    await page.waitForTimeout(500);
    await page.screenshot({ path: fullPath, fullPage: true });
    console.log(`[capture] Screenshot captured at ${fullPath}`);

    await browser.close();
    return { success: true, path: relOut };
  } catch (err) {
    await browser.close();
    return { success: false, error: err.message };
  }
}
