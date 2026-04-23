// tools/diff.js
import fs from "fs";
import path from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { WORKSPACE_ROOT, resolveWorkspacePath } from "./workspace_utils.js";

const DEFAULT_THRESHOLD = 0.02;

export function diffUI({
  reference = "reference_ui.png",
  current = "current_ui.png",
  diffOut = "diff.png",
  threshold = DEFAULT_THRESHOLD
} = {}) {
  // Ensure relative paths
  reference = reference.replace(/^\/+/, "");
  current = current.replace(/^\/+/, "");
  diffOut = diffOut.replace(/^\/+/, "");

  const { fullPath: refPath } = resolveWorkspacePath(reference);
  const { fullPath: curPath } = resolveWorkspacePath(current);
  const { fullPath: diffPath } = resolveWorkspacePath(diffOut);

  if (!fs.existsSync(refPath) || !fs.existsSync(curPath)) {
    return {
      success: false,
      error: "Missing reference or current image.",
      reference,
      current
    };
  }

  const img1 = PNG.sync.read(fs.readFileSync(refPath));
  const img2 = PNG.sync.read(fs.readFileSync(curPath));

  if (img1.width !== img2.width || img1.height !== img2.height) {
    return {
      success: false,
      error: "Image dimensions mismatch",
      refWidth: img1.width,
      refHeight: img1.height,
      curWidth: img2.width,
      curHeight: img2.height
    };
  }

  const { width, height } = img1;
  const diff = new PNG({ width, height });

  const mismatches = pixelmatch(img1.data, img2.data, diff.data, width, height, {
    threshold
  });

  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const diffPercent = (mismatches / (width * height)) * 100;

  return {
    success: true,
    mismatches,
    diffPercent,
    width,
    height,
    diffPath: diffOut
  };
}
