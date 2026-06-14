import fs from "fs";
import OpenAI from "openai";
import FormData from "form-data";
import {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  WHISPER_MODEL,
} from "./config/openai.mjs";

const audioPath = process.argv[2] || process.env.USER_AUDIO_PATH;

if (!audioPath) {
  console.error("No audio file path provided.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
});

async function main() {
  const form = new FormData();
  form.append("model", WHISPER_MODEL);
  form.append("file", fs.createReadStream(audioPath));

  const res = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whisper failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  process.stdout.write((json.text || "").trim());
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});