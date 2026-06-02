import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = process.cwd();
export const BACKEND_ROOT = path.join(PROJECT_ROOT, "backend");
export const FRONTEND_ROOT = path.join(PROJECT_ROOT, "frontend");
export const PLANS_DIR = PROJECT_ROOT;
export const PIPELINE_SCRIPT = path.resolve(__dirname, "../../pipeline_agent.mjs");

export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-Sy5TxZ3dcQAfM00dTwH5p8HqQ8hCqh2sf9TzNOfIfTYUmMnD";

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY env var.");
}

export const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: 30000,
  maxRetries: 2,
});