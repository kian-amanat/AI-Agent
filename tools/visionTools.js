// tools/visionTools.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "YOUR_API_KEY_HERE",
  baseURL: process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1",
});

/**
 * خواندن تصویر و برگرداندن data URL base64
 */
function imageToDataUrl(imagePath) {
  const full = path.resolve(imagePath);
  if (!fs.existsSync(full)) {
    throw new Error(`Image not found: ${full}`);
  }
  const stat = fs.statSync(full);
  if (!stat.size) {
    throw new Error(`Image is empty: ${full}`);
  }
  const base64 = fs.readFileSync(full, { encoding: "base64" });
  return `data:image/png;base64,${base64}`;
}

/**
 * تحلیل یک اسکرین‌شات (نسخه ساده – فقط reference)
 */
export async function analyzeScreenshot(imagePath) {
  const dataUrl = imageToDataUrl(imagePath);

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Analyze this login UI screenshot and return a concise JSON structure describing:\n" +
              "- layout hierarchy (containers, header, form, inputs, buttons)\n" +
              "- colors (hex where possible)\n" +
              "- spacing (margin/padding in px)\n" +
              "- typography (font size, weight, alignment)",
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  return response.choices[0].message.content;
}

/**
 * تحلیل سه تصویر: reference + current + diff
 * خروجی: JSON دقیق از اختلافات
 */
export async function analyzeUIWithDiff({
  referencePath,
  currentPath,
  diffPath,
}) {
  const referenceUrl = imageToDataUrl(referencePath);
  const currentUrl = imageToDataUrl(currentPath);
  const diffUrl = imageToDataUrl(diffPath);

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "You are a pixel‑perfect UI inspector.\n" +
              "You will see three images:\n" +
              "1) reference: the target design\n" +
              "2) current: the current implementation\n" +
              "3) diff: pixel diff (white = match, colored = mismatch)\n\n" +
              "Return STRICT JSON with this shape:\n" +
              "{\n" +
              '  "summary": string,\n' +
              '  "global_issues": [ { "type": string, "description": string } ],\n' +
              '  "element_issues": [\n' +
              '    {\n' +
              '      "element": string,\n' +
              '      "selector_hint": string,\n' +
              '      "problems": [string],\n' +
              '      "suggested_tailwind_fixes": [string]\n' +
              "    }\n" +
              "  ]\n" +
              "}\n\n" +
              "Focus on concrete, implementable Tailwind changes (e.g. 'mt-6 -> mt-4', 'bg-blue-500 -> #2563EB', 'rounded-lg -> rounded-xl').",
          },
          { type: "image_url", image_url: { url: referenceUrl } },
          { type: "image_url", image_url: { url: currentUrl } },
          { type: "image_url", image_url: { url: diffUrl } },
        ],
      },
    ],
  });

  return response.choices[0].message.content;
}
