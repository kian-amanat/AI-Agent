import {
  openai,
  CHAT_MODEL,
  SUMMARY_MODEL,
} from "../config/openai.mjs";
import { detectLanguage } from "./intent.service.mjs";
import { getSessionMessages } from "./session.service.mjs";
import { getMemory, getMemoryContext } from "./memory.service.mjs";
import { buildAttachmentContext } from "./attachments.service.mjs";
import {
  collectInspectionTargets,
  readFileContent,
  stripToPreview,
} from "../utils/file.util.mjs";

function writeSSE(reply, payload) {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function uniq(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function getRememberedTarget(sessionId) {
  if (!sessionId) return "";
  const memory = getMemory(sessionId);
  return String(memory?.last_target_file || "").trim();
}

function buildMemoryBlock(sessionId) {
  if (!sessionId) return "";
  return getMemoryContext(sessionId);
}

export async function generateGreetingResponse(message, sessionId) {
  const lang = detectLanguage(message);

  const history = getSessionMessages(sessionId) || [];
  const recentHistory = history.slice(-8);

  const historyText =
    recentHistory.length > 1
      ? recentHistory
          .slice(0, -1)
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")
      : null;

  const memoryText = buildMemoryBlock(sessionId);

  const systemPrompt =
    lang === "en"
      ? `You are a concise AI assistant that plans and builds full-stack software projects end-to-end (planning → scaffolding → codegen → testing → fixing).

The user just greeted you. Reply naturally and briefly — do NOT list your capabilities as bullet points.
${historyText ? "There is prior conversation context — acknowledge it and suggest a next step." : "No prior context — ask one open question about what they want to build."}
${memoryText ? "You also have saved memory from previous turns; use it if relevant." : ""}
Keep it under 3 sentences. End with a question.`
      : `تو یه دستیار هوشمند هستی که پروژه‌های نرم‌افزاری فول‌استک رو از صفر تا آخر می‌سازی (برنامه‌ریزی → scaffold → تولید کد → تست → رفع باگ).

کاربر بهت سلام کرده. طبیعی و کوتاه جواب بده — قابلیت‌هات رو به صورت لیست bullet ننویس.
${historyText ? "مکالمه قبلی وجود داره — بهش اشاره کن و یه قدم بعدی پیشنهاد بده." : "مکالمه قبلی نیست — یه سوال باز بپرس که می‌خوان چی بسازن."}
${memoryText ? "همچنین حافظه‌ی ذخیره‌شده از پیام‌های قبلی را در صورت مرتبط بودن در نظر بگیر." : ""}
حداکثر ۳ جمله. با یه سوال تموم کن.`;

  const userContent = [
    `User said: "${message}"`,
    historyText ? `Previous conversation:\n${historyText}` : "",
    memoryText ? `Saved memory:\n${memoryText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const fallbacks = {
    en: "Hey! I build full-stack projects end-to-end — from planning to working code. What are you looking to build?",
    fa: "سلام! من پروژه‌های فول‌استک رو از صفر تا کد نهایی می‌سازم. می‌خوای چی بسازیم؟",
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.9,
      max_tokens: 120,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    return (
      response?.choices?.[0]?.message?.content?.trim() ||
      fallbacks[lang]
    );
  } catch (err) {
    console.log("⚠️  Greeting AI failed, using fallback:", err.message);
    return fallbacks[lang];
  }
}

export async function generateInspectionResponse(message, attachments = [], sessionId = "") {
  const lang = detectLanguage(message);

  const rememberedTarget = getRememberedTarget(sessionId);
  const matchedTargets = uniq([
    ...(await collectInspectionTargets(message, attachments)),
    rememberedTarget,
  ]);

  const attachmentContext = buildAttachmentContext(attachments);

  const attachmentSnippets = [];
  for (const item of attachments.slice(0, 6)) {
    if (item.kind === "text" && item.preview) {
      attachmentSnippets.push(
        `FILE: ${item.path}\nORIGINAL: ${item.originalName}\nPREVIEW:\n${item.preview}`
      );
    } else if (item.kind === "image") {
      attachmentSnippets.push(
        `FILE: ${item.path}\nORIGINAL: ${item.originalName}\nIMAGE ANALYSIS:\n${
          item.analysis || "No vision summary available."
        }`
      );
    }
  }

  if (!matchedTargets.length && !attachmentSnippets.length) {
    return lang === "en"
      ? "I couldn't find a direct match in the workspace, but I can inspect broader files if you share a more specific file name or path."
      : "فایل دقیقی در workspace پیدا نکردم، ولی اگر نام یا مسیر دقیق‌تری بدی می‌تونم گسترده‌تر بررسی کنم.";
  }

  const snippets = [];
  for (const target of matchedTargets.slice(0, 6)) {
    const content = await readFileContent(target);
    if (content) snippets.push({ path: target, content });
  }

  const intro =
    lang === "en"
      ? "Yes — I can inspect the workspace. These are the most likely matches:"
      : "بله — می‌تونم workspace رو بررسی کنم. این‌ها فایل‌های محتمل هستند:";

  const lines = [intro];

  if (matchedTargets.length) {
    lines.push(...matchedTargets.slice(0, 10).map((f) => `- ${f}`));
  }

  if (snippets.length) {
    lines.push("", lang === "en" ? "Relevant excerpts:" : "بخش‌های مرتبط:");
    for (const snippet of snippets.slice(0, 3)) {
      lines.push("", `FILE: ${snippet.path}\n${stripToPreview(snippet.content, 5000)}`);
    }
  }

  if (attachmentContext) {
    lines.push(
      "",
      lang === "en"
        ? "Uploaded attachment context:"
        : "کانتکست فایل/عکس‌های آپلودشده:"
    );
    lines.push(attachmentContext);
  }

  if (!matchedTargets.length && attachmentSnippets.length) {
    lines.push("", lang === "en" ? "Uploaded files:" : "فایل‌های آپلودشده:");
    lines.push(...attachmentSnippets);
  }

  return lines.join("\n");
}

export async function generateCodeResponse(message, attachments = [], sessionId = "") {
  const lang = detectLanguage(message);

  const rememberedTarget = getRememberedTarget(sessionId);
  const matchedTargets = uniq([
    ...(await collectInspectionTargets(message, attachments)),
    rememberedTarget,
  ]);

  const attachmentContext = buildAttachmentContext(attachments);

  if (!matchedTargets.length && !attachmentContext) {
    return lang === "en"
      ? "I couldn't find the exact file for that code request. Send the exact file path or filename and I’ll pull the code."
      : "فایل دقیق برای این درخواست کد پیدا نشد. مسیر یا نام دقیق فایل را بفرست تا کدش را برات بیارم.";
  }

  const snippets = [];
  for (const target of matchedTargets.slice(0, 4)) {
    const content = await readFileContent(target);
    if (content) {
      const language = target.endsWith(".tsx") || target.endsWith(".ts")
        ? "ts"
        : target.endsWith(".jsx") || target.endsWith(".js")
          ? "js"
          : target.endsWith(".css")
            ? "css"
            : "";
      snippets.push(
        `FILE: ${target}\n${language ? `\`\`\`${language}\n` : "```"}${content}\n\`\`\``
      );
    }
  }

  if (!snippets.length && attachmentContext) {
    return attachmentContext;
  }

  if (!snippets.length) {
    return lang === "en"
      ? "I found likely files, but I could not read their contents."
      : "فایل‌های محتمل پیدا شدند، اما نتونستم محتوایشان را بخوانم.";
  }

  return snippets.join("\n\n");
}

export async function generateClarificationResponse(message) {
  const lang = detectLanguage(message);
  const fallbacks = {
    en: "I'd love to help you build that! To create a better plan, could you provide more details:\n\n• Is this frontend, backend, or full-stack?\n• What are the main features?\n• Any tech preferences (React, Vue, Node.js, etc.)?\n• Expected scale (users, data volume)?\n\nThe more details, the better plan I can create! 🚀",
    fa: "خوشحال می‌شم کمکت کنم این رو بسازی! برای ساخت plan بهتر، می‌تونی جزئیات بیشتری بدی:\n\n• فرانت‌اند، بک‌اند یا فول‌استک؟\n• ویژگی‌های اصلی چیا هستن؟\n• تکنولوژی خاصی رو ترجیح می‌دی (React، Vue، Node.js و...)؟\n• مقیاس مورد انتظار چقدره (تعداد کاربر، حجم داده)؟\n\nهرچی بیشتر توضیح بدی، plan بهتری می‌سازم! 🚀",
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: `You are a technical requirements analyst. User made a vague request. Ask 3-4 specific clarifying questions about:
- Frontend/backend/fullstack?
- Key features needed?
- Tech preferences?
- Scale/users expected?
Respond in ${lang === "en" ? "English" : "Farsi"}. Be friendly, concise (3-4 sentences max).`,
        },
        { role: "user", content: message },
      ],
      temperature: 0.7,
      max_tokens: 200,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.choices[0].message.content;
  } catch {
    console.log("⚠️  Clarification AI failed, using fallback");
    return fallbacks[lang];
  }
}

export async function generateCasualResponse(message) {
  const lang = detectLanguage(message);
  const fallbacks = {
    en: "I'm here to help you plan and build software projects! Could you tell me more about what you'd like to create? For example:\n• A web application\n• A mobile backend\n• An API service\n• Something else?",
    fa: "من اینجام تا کمکت کنم پروژه‌های نرم‌افزاری بسازی! می‌تونی بیشتر بگی می‌خوای چی بسازی؟ مثلاً:\n• یک اپلیکیشن وب\n• بک‌اند موبایل\n• یک سرویس API\n• چیز دیگه‌ای؟",
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: `You are a friendly AI assistant for software project planning. Respond warmly in ${lang === "en" ? "English" : "Farsi"} and guide user toward describing their project. Keep it brief (2-3 sentences).`,
        },
        { role: "user", content: message },
      ],
      temperature: 0.7,
      max_tokens: 120,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.choices[0].message.content;
  } catch {
    console.log("⚠️  Casual response AI failed, using fallback");
    return fallbacks[lang];
  }
}

function createFallbackSummary(plan, lang = "en") {
  return lang === "en"
    ? `✅ **Pipeline Completed Successfully!**\n\n**🎯 Goal:** ${
        plan.goal || "Complete implementation"
      }\n\n**📦 Pipeline Results:**\n• ✅ Planning complete (${plan.phases?.length || 0} phases)\n• ✅ Scaffolding done (${plan.files?.length || 0} files)\n• ✅ Code generated\n• ✅ Tests created\n• ✅ Fixes applied\n\nYour project is ready! 🚀`
    : `✅ **Pipeline با موفقیت اجرا شد!**\n\n**🎯 هدف:** ${
        plan.goal || "پیاده‌سازی کامل"
      }\n\n**📦 نتایج Pipeline:**\n• ✅ برنامه‌ریزی کامل (${plan.phases?.length || 0} فاز)\n• ✅ ساختار ساخته شد (${plan.files?.length || 0} فایل)\n• ✅ کد تولید شد\n• ✅ تست‌ها ساخته شدند\n• ✅ اصلاحات اعمال شد\n\nپروژه‌ت آماده است! 🚀`;
}

export async function streamPlanSummary(plan, userMessage, reply) {
  const lang = detectLanguage(userMessage);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    const stream = await openai.chat.completions.create({
      model: SUMMARY_MODEL,
      messages: [
        {
          role: "system",
          content: `Return summary ONLY as bullet points. Every line MUST start with "- ". No paragraphs. No JSON/code. Language: ${
            lang === "en" ? "English" : "Farsi"
          }. 6-10 bullets max. Mention that full pipeline was executed (planning, scaffolding, codegen, testing, fixing).`,
        },
        {
          role: "user",
          content: `User: "${userMessage}"\n\nPipeline completed. Plan: ${
            plan.phases?.length || 0
          } phases, ${plan.files?.length || 0} files.\n\nSummarize briefly.`,
        },
      ],
      temperature: 0.2,
      max_tokens: 300,
      stream: true,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    let fullContent = "";
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) fullContent += content;
    }

    const hasBullets = /(^|\n)\s*[-•]\s+/.test(fullContent);
    if (!hasBullets) {
      fullContent = fullContent
        .replace(/\n+/g, " ")
        .split(/(?<=[.!?])\s+/)
        .filter(Boolean)
        .map((s) => `- ${s}`)
        .join("\n");
    }

    reply.raw.write(`data: ${JSON.stringify({ type: "content", content: fullContent })}\n\n`);
    return fullContent;
  } catch {
    console.log("⚠️  Summary AI failed, using fallback");
    const fallback = createFallbackSummary(plan, lang);
    reply.raw.write(`data: ${JSON.stringify({ type: "content", content: fallback })}\n\n`);
    return fallback;
  }
}