import fsSync, { promises as fs } from "fs";
import path from "path";

import { openai, PROJECT_ROOT } from "../config/openai.mjs";
import {
  inferMimeTypeFromPath,
  isImageMime,
  isInsideProjectRoot,
  isPdfAttachment,
  isTextLikeAttachment,
  normalizePath,
} from "../utils/path.util.mjs";
import { readFileContent, stripToPreview } from "../utils/file.util.mjs";
import { uniq } from "../utils/text.util.mjs";

const MAX_PDF_TEXT_CHARS = 9_000;

// Extract text from a PDF so it can be handed to ANY model as text — no vision
// model required. Returns "" on failure (scanned/image-only PDFs yield little
// or nothing; that's the one case where a vision model would still be needed).
export async function extractPdfText(relPath) {
  try {
    const { PDFParse } = await import("pdf-parse");
    const absPath = path.resolve(PROJECT_ROOT, relPath);
    const buffer = await fs.readFile(absPath);
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return String(result?.text || "").trim().slice(0, MAX_PDF_TEXT_CHARS);
    } finally {
      await parser.destroy?.().catch(() => {});
    }
  } catch (err) {
    console.log("⚠️  PDF text extraction failed:", err.message);
    return "";
  }
}

export function buildAttachmentInfoPaths(inputPaths = []) {
  return uniq(
    (Array.isArray(inputPaths) ? inputPaths : [])
      .map((item) => (typeof item === "string" ? item : item?.path))
      .map((p) => normalizePath(p))
      .filter(Boolean)
  );
}

export function buildAttachmentContext(attachments = []) {
  if (!attachments.length) return "";

  const blocks = [];

  for (const item of attachments) {
    if ((item.kind === "text" || item.kind === "pdf") && item.preview) {
      const label = item.kind === "pdf" ? "pdf (extracted text)" : "text";
      blocks.push(
        `FILE: ${item.path}\nORIGINAL: ${item.originalName}\nTYPE: ${label}\nCONTENT:\n${item.preview}`
      );
      continue;
    }

    if (item.kind === "image") {
      blocks.push(
        `FILE: ${item.path}\nORIGINAL: ${item.originalName}\nTYPE: image\nANALYSIS:\n${
          item.analysis || "No vision summary available."
        }`
      );
      continue;
    }

    blocks.push(
      `FILE: ${item.path}\nORIGINAL: ${item.originalName}\nTYPE: ${item.kind}\nSIZE: ${item.size}`
    );
  }

  return blocks.join("\n---\n");
}

export async function analyzeImageAttachment(relPath, mimeType) {
  try {
    const absPath = path.resolve(PROJECT_ROOT, relPath);
    const buffer = await fs.readFile(absPath);
    const base64 = buffer.toString("base64");
    const dataUrl = `data:${mimeType || "image/png"};base64,${base64}`;

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 350,
      messages: [
        {
          role: "system",
          content:
            "You describe uploaded images for a software engineering agent. Focus on UI layout, visible text, colors, spacing, buttons, forms, and any code or screenshots shown. Return a concise but useful description.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this uploaded image for the agent." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    return response.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.log("⚠️  Image analysis failed, using metadata only:", err.message);
    return "";
  }
}

export async function loadAttachmentsFromPaths(inputPaths = []) {
  const pathsList = buildAttachmentInfoPaths(inputPaths);
  const attachments = [];

  for (const rel of pathsList) {
    const abs = path.resolve(PROJECT_ROOT, rel);
    if (!isInsideProjectRoot(abs) || !fsSync.existsSync(abs)) continue;

    let stat;
    try {
      stat = fsSync.statSync(abs);
    } catch {
      continue;
    }

    if (!stat.isFile()) continue;

    const mimeType = inferMimeTypeFromPath(rel);
    const originalName = path.basename(rel);

    const item = {
      path: rel,
      originalName,
      mimeType,
      size: stat.size,
      kind: isImageMime(mimeType, rel)
        ? "image"
        : isPdfAttachment(rel, mimeType)
          ? "pdf"
          : isTextLikeAttachment(rel, mimeType)
            ? "text"
            : "binary",
      preview: "",
      analysis: "",
    };

    if (item.kind === "text") {
      const content = await readFileContent(rel);
      item.preview = stripToPreview(content, 5000);
    } else if (item.kind === "pdf") {
      // Extract the PDF's text so any (non-vision) model can read it.
      const text = await extractPdfText(rel);
      item.preview = text || "(No extractable text — this PDF may be a scanned image; attach it to a vision model to read it.)";
    } else if (item.kind === "image") {
      item.analysis = await analyzeImageAttachment(rel, mimeType);
    }

    attachments.push(item);
  }

  return attachments;
}