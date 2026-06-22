import openai from "./openai.models.mjs";
import anthropic from "./anthropic.models.mjs";
import gapgpt from "./gapgpt.models.mjs";
import deepseek from "./deepseek.models.mjs";

export const PROVIDERS = [
  openai,
  anthropic,
  gapgpt,
  deepseek,
];