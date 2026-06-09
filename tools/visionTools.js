// tools/visionTools.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import sharp from "sharp";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "***REMOVED-SECRET***",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
});

/**
 * Read image and return base64 data URL
 */
function imageToDataUrl(imagePath) {
  const full = path.resolve(imagePath);
  if (!fs.existsSync(full)) throw new Error(`Image not found: ${full}`);

  const stat = fs.statSync(full);
  if (!stat.size) throw new Error(`Image is empty: ${full}`);

  const ext = path.extname(full).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
      ? "image/webp"
      : "image/png";

  const base64 = fs.readFileSync(full, { encoding: "base64" });
  return `data:${mime};base64,${base64}`;
}

/**
 * Utility: extract model text content regardless of array/string content formats
 */
function extractTextContent(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

/**
 * Utility: strip accidental markdown fences
 */
function stripFences(s) {
  if (!s) return "";
  return s
    .replace(/```json\s*/gi, "")
.replace(/```javascript\s*/gi, "")
    .replace(/```js\s*/gi, "")
.replace(/```\s*/gi, "")
    .trim();
}

/**
 * Utility: try to extract the first top-level JSON object from text.
 */
function extractFirstJsonBlock(text) {
  if (!text) return "";
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return text;
  }
  return text.slice(firstBrace, lastBrace + 1);
}

/**
 * Segment the reference UI into logical regions for better analysis.
 * Output files in outDir:
 *   full.png, sidebar.png, chat.png, input.png
 */
export async function segmentReferenceUI(inputPath, outDir) {
  const fullPath = path.resolve(inputPath);
  await fs.promises.mkdir(outDir, { recursive: true });

  const base = sharp(fullPath);
  const meta = await base.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;

  if (!width || !height) {
    throw new Error("Cannot read image dimensions for segmentation.");
  }

  // Save full for sanity
  await base.clone().toFile(path.join(outDir, "full.png"));

  // Heuristic: right sidebar approx 28% width
  const sidebarWidth = Math.round(width * 0.28);
  const sidebarX = width - sidebarWidth;

  await base
    .clone()
    .extract({ left: sidebarX, top: 0, width: sidebarWidth, height })
    .toFile(path.join(outDir, "sidebar.png"));

  await base
    .clone()
    .extract({ left: 0, top: 0, width: width - sidebarWidth, height })
    .toFile(path.join(outDir, "chat.png"));

  // bottom ~22% of full height as input region,
  // cropped به یک باند وسط افقی، تا noise کناره‌ها کمتر شود
  const inputHeight = Math.round(height * 0.22);
  const inputTop = height - inputHeight;
  await base
    .clone()
    .extract({
      left: Math.round(width * 0.12),
      top: inputTop,
      width: Math.round(width * 0.76),
      height: inputHeight,
    })
    .toFile(path.join(outDir, "input.png"));

  return {
    width,
    height,
    sidebarWidth,
  };
}

/**
 * Sample average color from a region (in full image coordinates).
 * region: { left, top, width, height }
 */
export async function sampleAverageColor(imagePath, region) {
  const { left, top, width, height } = region;
  const image = sharp(imagePath);

  // مطمئن شو خارج از محدوده نمی‌رویم
  const meta = await image.metadata();
  const safeRegion = {
    left: Math.max(0, Math.min(left, (meta.width || 1) - 1)),
    top: Math.max(0, Math.min(top, (meta.height || 1) - 1)),
    width: Math.max(1, Math.min(width, (meta.width || 1) - left)),
    height: Math.max(1, Math.min(height, (meta.height || 1) - top)),
  };

  const buffer = await image
    .extract(safeRegion)
    .raw()
    .toBuffer();
  const pixels = new Uint8Array(buffer);
  let r = 0,
    g = 0,
    b = 0;
  const len = pixels.length;

  // فرض ۳ کانال (RGB)
  for (let i = 0; i < len; i += 3) {
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
  }
  const count = len / 3;
  r = Math.round(r / count);
  g = Math.round(g / count);
  b = Math.round(b / count);

  const toHex = (v) => v.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Use Vision ONLY to understand structure (no precise numbers).
 * Returns a coarse structuralSpec.
 */
async function analyzeStructureWithVision(imagePath, options = {}) {
  const { model = "gpt-5.2", max_tokens = 1200, temperature = 0.0 } = options;
  const dataUrl = imageToDataUrl(imagePath);

  const system = `
You are a STRUCTURE-ONLY UI analyzer.
Do NOT guess exact pixel values or hex colors.
Just describe the structure and relative layout of regions.

You MUST output ONLY valid JSON with this shape:
{
  "has_right_sidebar": boolean | null,
  "sidebar_width_ratio": number | null,
  "has_bottom_input": boolean | null,
  "notes": string
}

Rules:
- sidebar_width_ratio is between 0 and 0.5 (e.g. 0.25 means 25% of width).
- If unsure, set fields to null and explain in notes. Do NOT invent details.
`.trim();

  const user = `
Analyze this screenshot and only tell me:
- Is there a right sidebar?
- Roughly what fraction of width it occupies?
- Is there a bottom-centered input bar?

Return JSON exactly as specified.
`.trim();

  const resp = await client.chat.completions.create({
    model,
    temperature,
    max_tokens,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  const raw = extractTextContent(resp.choices?.[0]?.message);
  const cleaned = stripFences(raw);
  const jsonCandidate = extractFirstJsonBlock(cleaned);

  let obj;
  try {
    obj = JSON.parse(jsonCandidate);
  } catch (e) {
    const err = new Error("Structure analysis did not return valid JSON.");
    err.cause = e;
    throw err;
  }

  // نرمال‌سازی خروجی
  return {
    has_right_sidebar:
      typeof obj.has_right_sidebar === "boolean"
        ? obj.has_right_sidebar
        : null,
    sidebar_width_ratio:
      typeof obj.sidebar_width_ratio === "number"
        ? obj.sidebar_width_ratio
        : null,
    has_bottom_input:
      typeof obj.has_bottom_input === "boolean"
        ? obj.has_bottom_input
        : null,
    notes: typeof obj.notes === "string" ? obj.notes : "",
  };
}

/**
 * Advanced screenshot analysis:
 * - sharp: precise canvas width/height, sidebar width, sample colors
 * - vision: coarse structure
 * - post-process into strict layoutSpec
 *
 * این تابع توسط agent.js صدا زده می‌شود و layoutSpec اصلی را می‌سازد.
 */
export async function analyzeScreenshotAdvanced(imagePath, options = {}) {
  const {
    model = "gpt-4o-mini",
    max_tokens = 2200, // استفاده نمی‌شود ولی برای هم‌خوانی با agent.js نگه می‌داریم
    temperature = 0.0,
    debugOutDir = null, // e.g. "/abs/path/layout-debug"
  } = options;

  const resolved = path.resolve(imagePath);
  const segmentsDir = debugOutDir
    ? path.join(debugOutDir, "segments")
    : path.join(path.dirname(resolved), ".segments");

  const meta = await segmentReferenceUI(resolved, segmentsDir);

  if (debugOutDir) {
    fs.mkdirSync(debugOutDir, { recursive: true });
  }

  const { width, height, sidebarWidth } = meta;

  // 1) STRUCTURE via Vision (very coarse)
  const structure = await analyzeStructureWithVision(resolved, {
    model,
    max_tokens: 1200,
    temperature,
  });

  if (debugOutDir) {
    fs.writeFileSync(
      path.join(debugOutDir, "structure.json"),
      JSON.stringify(structure, null, 2),
      "utf8"
    );
  }

  // 2) PIXEL MEASUREMENTS via sharp
  // Canvas color from center 20x20 block
  const canvasColor = await sampleAverageColor(resolved, {
    left: Math.round(width * 0.5) - 10,
    top: Math.round(height * 0.5) - 10,
    width: 20,
    height: 20,
  });

  // Sidebar background from its central column
  const sidebarColor = await sampleAverageColor(resolved, {
    left: width - Math.round(sidebarWidth / 2) - 10,
    top: Math.round(height * 0.3),
    width: 20,
    height: 20,
  });

  // Input bar approximate area (bottom central band)
  const inputSampleColor = await sampleAverageColor(resolved, {
    left: Math.round(width * 0.3),
    top: Math.round(height * 0.8),
    width: Math.round(width * 0.4),
    height: Math.round(height * 0.06),
  });

  // 3) Build strict layoutSpec (numbers from measurements + deterministic defaults)
  const sidebarRatioMeasured = sidebarWidth / width;

  const layoutSpec = {
    canvas: {
      width,
      height,
      background_color: canvasColor,
    },
    shell: {
      max_width: width,
      min_height: height,
      background_color: canvasColor,
      border_color: null,
      border_width: 0,
      border_radius: 0,
      shadow: "none",
    },
    layout: {
      outer_padding_x: 0,
      outer_padding_y: 0,
      column_gap: 0,
    },
    sidebar: {
      width: sidebarWidth,
      // اگر vision هم نسبت رو تشخیص داده، جهت info نگه می‌داریم (مصرفش با agent.js است)
      width_ratio_vision: structure.sidebar_width_ratio,
      width_ratio_measured: sidebarRatioMeasured,
      background_color: sidebarColor,
      border_right_color: "#272727", // agent.js بعداً می‌تواند override کند
      padding_x: 16,
      padding_y: 16,
      section_gap: 12,
    },
    main: {
      background_color: canvasColor,
      padding_x: 32,
      padding_y: 24,
    },
    header: {
      height: 0,
      background_color: canvasColor,
      border_bottom_color: null,
      padding_x: 0,
    },
    message_list: {
      padding_x: 24,
      padding_y: 24,
      row_gap: 16,
      max_width_ratio: 0.55,
    },
    message_bubble: {
      assistant_bg: "#262626",
      user_bg: "#1f2933",
      border_radius: 18,
      padding_x: 16,
      padding_y: 10,
      text_color: "#f5f5f5",
    },
    input_bar: {
      height: 56,
      background_color: inputSampleColor,
      border_top_color: canvasColor,
      padding_x: 20,
      padding_y: 12,
      field_radius: 999,
      button_radius: 999,
      accent_color: "#fb7185",
    },
    colors: {
      bg: canvasColor,
      surface: canvasColor,
      surface_2: "#181818",
      border: "#272727",
      text: "#f5f5f5",
      text_muted: "#9ca3af",
      accent: "#fb7185",
    },
    typography: {
      font_family_hint: "Inter, system-ui, sans-serif",
      title_size: 16,
      title_weight: 600,
      body_size: 14,
      body_weight: 400,
      muted_size: 13,
      muted_weight: 400,
      line_height: 20,
    },
    _meta: {
      structure,
      source_image: path.basename(imagePath),
      notes: "canvas/sidebar colors from sharp; structure from vision; numeric defaults deterministic.",
    },
  };

  if (debugOutDir) {
    fs.writeFileSync(
      path.join(debugOutDir, "layoutSpec.json"),
      JSON.stringify(layoutSpec, null, 2),
      "utf8"
    );
  }

  return layoutSpec;
}

/**
 * Analyze reference+current+diff for pixel mismatch hints.
 * Returns STRICT JSON as object.
 *
 * ⚠️ امضای این تابع را با چیزی که در agent.js استفاده می‌کنی هماهنگ کردم:
 *    analyzeUIWithDiff({
 *      referenceImagePath,
 *      generatedImagePath,
 *      diffImagePath,
 *      model,
 *      max_tokens,
 *    })
 */
export async function analyzeUIWithDiff(
  {
    referenceImagePath,
    generatedImagePath,
    diffImagePath,
    // برای سازگاری با نسخه‌ای که شاید قبلاً نوشتی:
    referencePath,
    currentPath,
    diffPath,
  },
  options = {}
) {
  const {
    model = "gpt-4o-mini",
    max_tokens = 2200,
    temperature = 0.0,
    debugOutPath = null,
  } = options;

  // backward-compat: اگر پارامترهای قدیمی پاس داده شوند، استفاده کن
  const refPath = referenceImagePath || referencePath;
  const curPath = generatedImagePath || currentPath;
  const dPath = diffImagePath || diffPath;

  if (!refPath || !curPath || !dPath) {
    throw new Error(
      "analyzeUIWithDiff requires { referenceImagePath, generatedImagePath, diffImagePath }"
    );
  }

  const referenceUrl = imageToDataUrl(refPath);
  const currentUrl = imageToDataUrl(curPath);
  const diffUrl = imageToDataUrl(dPath);

  const system = `
You are a strict pixel-perfect UI inspector.
You MUST output ONLY valid JSON. No prose, no markdown.

Your goal:
- Compare a reference UI vs a current implementation using a pixel-diff image.
- Identify concrete visual mismatches (colors, spacings, sizes, radii, positions).
- Suggest Tailwind-level adjustments (class changes) that would reduce the diff.

Keep descriptions concise but specific.
`.trim();

  const user = `
You will see three images:
1) reference: target design (Avand-style chatbot with right sidebar)
2) current: current implementation
3) diff: pixel diff (white = match, colored = mismatch)

Return STRICT JSON with EXACT shape:

{
  "summary": string,
  "global_issues": [
    { "type": string, "description": string, "severity": "low"|"med"|"high" }
  ],
  "element_issues": [
    {
      "element": string,
      "selector_hint": string,
      "bbox_hint": { "x": number, "y": number, "w": number, "h": number } | null,
      "problems": [string],
      "suggested_tailwind_fixes": [string]
    }
  ]
}

Guidelines:
- "summary": 1–2 sentences summarizing the main mismatches.
- "global_issues": for things like overall background too light, sidebar width mismatch, font size off.
- "element_issues": focus on specific UI elements:
  - sidebar container
  - sidebar conversation item (active)
  - "New Chat" button
  - search input
  - main chat background
  - assistant message bubble
  - bottom input bar container
  - bottom input field
  - bottom send button
- "selector_hint": a CSS-like or React-component hint, e.g. ".sidebar", "ChatArea root", "InputBar root".
- "bbox_hint": approximate x, y, w, h in pixels in the full canvas; if unsure, set to null.
- "problems": each is a human-readable description ("sidebar appears ~30px wider than reference").
- "suggested_tailwind_fixes": each must be a concrete suggestion like:
  - "w-[360px] -> w-[320px]"
  - "px-6 -> px-[18px]"
  - "rounded-xl -> rounded-[28px]"
  - "bg-neutral-900 -> bg-[#111111]"
  - "border-neutral-700 -> border-[#272727]"

If you are unsure about exact numbers, approximate but keep diffs consistent with the images.
DO NOT return any extra fields or explanations outside the JSON structure.
`.trim();

  const resp = await client.chat.completions.create({
    model,
    temperature,
    max_tokens,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: referenceUrl } },
          { type: "image_url", image_url: { url: currentUrl } },
          { type: "image_url", image_url: { url: diffUrl } },
        ],
      },
    ],
  });

  const raw = extractTextContent(resp.choices?.[0]?.message);
  const cleaned = stripFences(raw);
  const jsonCandidate = extractFirstJsonBlock(cleaned);

  if (debugOutPath) {
    fs.mkdirSync(path.dirname(debugOutPath), { recursive: true });
    fs.writeFileSync(debugOutPath, raw || "", "utf8");
  }

  let obj;
  try {
    obj = JSON.parse(jsonCandidate);
  } catch (e) {
    const err = new Error(
      `Diff inspection did not return valid JSON. Saved raw output to: ${
        debugOutPath || "(no debug file)"
      }`
    );
    err.cause = e;
    throw err;
  }

  // نرمال‌سازی حداقلی ساختار
  obj.summary = typeof obj.summary === "string" ? obj.summary : "";
  obj.global_issues = Array.isArray(obj.global_issues)
    ? obj.global_issues
    : [];
  obj.element_issues = Array.isArray(obj.element_issues)
    ? obj.element_issues
    : [];

  return obj;
}
