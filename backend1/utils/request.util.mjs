import { safeJsonParse } from "./text.util.mjs";

function extractMultipartFields(rawText) {
  const result = {};
  const text = String(rawText || "");

  const fieldRegex =
    /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?\r?\n(?:Content-Type:[^\r\n]+\r?\n)?\r?\n([\s\S]*?)(?=\r?\n------|\r?\n--$|$)/g;

  for (const match of text.matchAll(fieldRegex)) {
    const [, name, filename, value] = match;
    const cleaned = String(value || "").replace(/\r?\n$/, "");

    if (filename) {
      result[name] = {
        filename,
        value: cleaned,
      };
    } else {
      result[name] = cleaned.trim();
    }
  }

  return result;
}

async function readRawBodyAsText(request) {
  try {
    const chunks = [];
    for await (const chunk of request.raw) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  }
}

function normalizeParsedPayload(payload, fallback = {}) {
  const out = { ...fallback, ...payload };

  if (typeof out.message === "string") out.message = out.message.trim();
  if (typeof out.text === "string") out.text = out.text.trim();
  if (typeof out.prompt === "string") out.prompt = out.prompt.trim();
  if (typeof out.session_id === "string") out.session_id = out.session_id.trim();

  return out;
}

export async function parseIncomingPayload(request) {
  const body = request.body;

  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    const maybeRaw = typeof body.message === "string" ? body.message : "";

    if (/Content-Disposition:\s*form-data/i.test(maybeRaw)) {
      const parsedMultipart = extractMultipartFields(maybeRaw);
      if (Object.keys(parsedMultipart).length) {
        return normalizeParsedPayload(parsedMultipart, body);
      }
    }

    return normalizeParsedPayload(body);
  }

  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return {};

    const multipartFields = extractMultipartFields(trimmed);
    if (Object.keys(multipartFields).length) {
      return normalizeParsedPayload(multipartFields);
    }

    const parsed = safeJsonParse(trimmed);
    if (parsed.ok && parsed.value && typeof parsed.value === "object") {
      return normalizeParsedPayload(parsed.value);
    }

    return { message: trimmed };
  }

  const raw = await readRawBodyAsText(request);
  if (!raw.trim()) return {};

  const multipartFields = extractMultipartFields(raw);
  if (Object.keys(multipartFields).length) {
    return normalizeParsedPayload(multipartFields);
  }

  const parsed = safeJsonParse(raw);
  if (parsed.ok && parsed.value && typeof parsed.value === "object") {
    return normalizeParsedPayload(parsed.value);
  }

  return { message: raw.trim() };
}

export { extractMultipartFields, readRawBodyAsText };