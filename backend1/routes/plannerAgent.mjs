import OpenAI from 'openai';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createSession, saveMessage, getSessionMessages, listSessions, deleteSession, touchSession } from '../db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------- OpenAI Config ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "sk-Sy5TxZ3dcQAfM00dTwH5p8HqQ8hCqh2sf9TzNOfIfTYUmMnD",
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.gapgpt.app/v1',
  timeout: 30000,
  maxRetries: 2,
});

const PLANS_DIR = '/Users/kkanamanat/Developer/ai-sandbox';
const PIPELINE_SCRIPT = path.resolve(__dirname, '../../pipeline_agent.mjs');

async function ensurePlansDir() {
  try {
    await fs.mkdir(PLANS_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create plans directory:', err);
  }
}

// --------- Crisis Detection ----------
function isCrisis(message) {
  const lower = message.toLowerCase().replace(/[^a-z\u0600-\u06FF\s]/g, ' ');

  const exactKeywords = [
    'suicide', 'kill myself', 'end my life', 'self harm', 'self-harm',
    'want to die', 'hurt myself', 'take my life',
    'خودکشی', 'بمیرم', 'خودم رو بکشم', 'آسیب به خودم'
  ];

  if (exactKeywords.some(k => lower.includes(k))) return true;

  const fuzzyPatterns = [
    /su[ei]?[ck]?[ie]?[cd]e/i,
    /kill\s*(my\s*self|me)/i,
    /end\s*(my|this)\s*(life|pain)/i,
    /don'?t\s*want\s*to\s*(live|be here)/i,
    /want\s*to\s*(die|disappear)/i,
  ];

  return fuzzyPatterns.some(p => p.test(lower));
}

// --------- Greeting Detection ----------
const GREETING_PATTERNS = [
  /^(hi|hello|hey|greetings|good morning|good afternoon|good evening)[\s!.?]*$/i,
  /^(thanks|thank you|thx|ty|appreciate it)[\s!.?]*$/i,
  /^(bye|goodbye|see you|cya|take care)[\s!.?]*$/i,
  /^(how are you|what's up|sup|wassup|how's it going|how do you do)[\s!.?]*$/i,
  /^(سلام|درود|صبح بخیر|عصر بخیر|شب بخیر)[\s!.?]*$/i,
  /^(ممنون|متشکرم|مرسی|سپاس)[\s!.?]*$/i,
  /^(خداحافظ|بای|فعلاً)[\s!.?]*$/i,
  /^(حالت چطوره|چطوری|خوبی|چه خبر)[\s!.?]*$/i,
];

// --------- Language Detection ----------
function detectLanguage(text) {
  const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
  const farsiChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return englishChars > farsiChars ? 'en' : 'fa';
}

function isGreeting(message) {
  return GREETING_PATTERNS.some(pattern => pattern.test(message.trim()));
}

// --------- Greeting Response (AI-driven, no hardcoded lists) ----------
async function generateGreetingResponse(message, sessionId) {
  const lang = detectLanguage(message);

  // get history — getSessionMessages is sync
  const history = getSessionMessages(sessionId) || [];
  const recentHistory = history.slice(-8);

  // build a short history string, skip the very last user message (that's `message` itself)
  const historyText = recentHistory.length > 1
    ? recentHistory
        .slice(0, -1) // exclude current message
        .map(m => `${m.role}: ${m.content}`)
        .join('\n')
    : null;

  // intentionally minimal prompt — let AI be natural, not templated
  const systemPrompt = lang === 'en'
    ? `You are a concise AI assistant that plans and builds full-stack software projects end-to-end (planning → scaffolding → codegen → testing → fixing).

The user just greeted you. Reply naturally and briefly — do NOT list your capabilities as bullet points.
${historyText ? 'There is prior conversation context — acknowledge it and suggest a next step.' : 'No prior context — ask one open question about what they want to build.'}
Keep it under 3 sentences. End with a question.`
    : `تو یه دستیار هوشمند هستی که پروژه‌های نرم‌افزاری فول‌استک رو از صفر تا آخر می‌سازی (برنامه‌ریزی → scaffold → تولید کد → تست → رفع باگ).

کاربر بهت سلام کرده. طبیعی و کوتاه جواب بده — قابلیت‌هات رو به صورت لیست bullet ننویس.
${historyText ? 'مکالمه قبلی وجود داره — بهش اشاره کن و یه قدم بعدی پیشنهاد بده.' : 'مکالمه قبلی نیست — یه سوال باز بپرس که می‌خوان چی بسازن.'}
حداکثر ۳ جمله. با یه سوال تموم کن.`;

  const userContent = historyText
    ? `User said: "${message}"\n\nPrevious conversation:\n${historyText}`
    : `User said: "${message}"`;

  const fallbacks = {
    en: "Hey! I build full-stack projects end-to-end — from planning to working code. What are you looking to build?",
    fa: "سلام! من پروژه‌های فول‌استک رو از صفر تا کد نهایی می‌سازم. می‌خوای چی بسازیم؟"
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.9,   // higher = more natural, less templated
      max_tokens: 120,    // short — force brevity
    });

    clearTimeout(timeoutId);
    return response.choices[0].message.content.trim();
  } catch (err) {
    console.log('⚠️  Greeting AI failed, using fallback:', err.message);
    return fallbacks[lang];
  }
}

// --------- Intent Classification ----------
async function classifyIntent(message) {
  const trimmed = message.trim();

  if (isCrisis(trimmed)) return { type: 'crisis', confidence: 1.0 };
  if (isGreeting(trimmed)) return { type: 'greeting', confidence: 1.0 };

  if (trimmed.length < 15 || trimmed.split(/\s+/).length < 4) {
    return { type: 'casual', confidence: 0.9 };
  }

  const technicalKeywords = [
    'api', 'backend', 'frontend', 'database', 'auth', 'dashboard',
    'react', 'vue', 'node', 'fastify', 'express', 'postgresql',
    'mongodb', 'microservice', 'rest', 'graphql', 'websocket',
    'دیتابیس', 'بک‌اند', 'فرانت‌اند', 'داشبورد', 'احراز هویت'
  ];

  const hasTechnicalKeyword = technicalKeywords.some(kw =>
    trimmed.toLowerCase().includes(kw)
  );

  const vaguePatterns = [
    /create\s+(a\s+)?dashboard/i,
    /build\s+(a\s+)?website/i,
    /make\s+(an?\s+)?app/i,
    /develop\s+(a\s+)?system/i,
    /بساز\s+داشبورد/i,
    /بساز\s+وب‌سایت/i,
    /بساز\s+اپلیکیشن/i,
  ];

  const isVague = vaguePatterns.some(pattern => pattern.test(trimmed));

  if (isVague && !hasTechnicalKeyword) return { type: 'clarification', confidence: 0.8 };
  if (hasTechnicalKeyword || trimmed.split(/\s+/).length > 10) return { type: 'technical', confidence: 0.9 };

  return { type: 'casual', confidence: 0.7 };
}

// --------- Response Generators ----------
async function generateClarificationResponse(message) {
  const lang = detectLanguage(message);
  const fallbacks = {
    en: "I'd love to help you build that! To create a better plan, could you provide more details:\n\n• Is this frontend, backend, or full-stack?\n• What are the main features?\n• Any tech preferences (React, Vue, Node.js, etc.)?\n• Expected scale (users, data volume)?\n\nThe more details, the better plan I can create! 🚀",
    fa: "خوشحال می‌شم کمکت کنم این رو بسازی! برای ساخت plan بهتر، می‌تونی جزئیات بیشتری بدی:\n\n• فرانت‌اند، بک‌اند یا فول‌استک؟\n• ویژگی‌های اصلی چیا هستن؟\n• تکنولوژی خاصی رو ترجیح می‌دی (React، Vue، Node.js و...)؟\n• مقیاس مورد انتظار چقدره (تعداد کاربر، حجم داده)؟\n\nهرچی بیشتر توضیح بدی، plan بهتری می‌سازم! 🚀"
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a technical requirements analyst. User made a vague request. Ask 3-4 specific clarifying questions about:
- Frontend/backend/fullstack?
- Key features needed?
- Tech preferences?
- Scale/users expected?
Respond in ${lang === 'en' ? 'English' : 'Farsi'}. Be friendly, concise (3-4 sentences max).`
        },
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 200,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response.choices[0].message.content;
  } catch {
    console.log('⚠️  Clarification AI failed, using fallback');
    return fallbacks[lang];
  }
}

async function generateCasualResponse(message) {
  const lang = detectLanguage(message);
  const fallbacks = {
    en: "I'm here to help you plan and build software projects! Could you tell me more about what you'd like to create? For example:\n• A web application\n• A mobile backend\n• An API service\n• Something else?",
    fa: "من اینجام تا کمکت کنم پروژه‌های نرم‌افزاری بسازی! می‌تونی بیشتر بگی می‌خوای چی بسازی؟ مثلاً:\n• یک اپلیکیشن وب\n• بک‌اند موبایل\n• یک سرویس API\n• چیز دیگه‌ای؟"
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a friendly AI assistant for software project planning. Respond warmly in ${lang === 'en' ? 'English' : 'Farsi'} and guide user toward describing their project. Keep it brief (2-3 sentences).`
        },
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 120,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response.choices[0].message.content;
  } catch {
    console.log('⚠️  Casual response AI failed, using fallback');
    return fallbacks[lang];
  }
}

// --------- Pipeline Runner ----------
async function runPipeline(message) {
  console.log('🚀 Starting full pipeline...');

  return new Promise((resolve, reject) => {
    const child = spawn('node', [PIPELINE_SCRIPT], {
      env: { ...process.env, USER_MESSAGE: message },
      cwd: path.resolve(__dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => process.stdout.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Pipeline timed out after 5 minutes'));
    }, 300000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        console.log('✅ Pipeline completed successfully');
        resolve();
      } else {
        reject(new Error(`Pipeline exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --------- Plan Management ----------
async function getNextPlannerFilename() {
  await ensurePlansDir();
  let counter = 1;
  while (true) {
    const filename = `planner${counter}.json`;
    try {
      await fs.access(path.join(PLANS_DIR, filename));
      counter++;
    } catch {
      return { filename, filepath: path.join(PLANS_DIR, filename) };
    }
  }
}

// --------- Stream Plan Summary ----------
async function streamPlanSummary(plan, userMessage, reply) {
  const lang = detectLanguage(userMessage);

  const createFallbackSummary = () => lang === 'en'
    ? `✅ **Pipeline Completed Successfully!**\n\n**🎯 Goal:** ${plan.goal || 'Complete implementation'}\n\n**📦 Pipeline Results:**\n• ✅ Planning complete (${plan.phases?.length || 0} phases)\n• ✅ Scaffolding done (${plan.files?.length || 0} files)\n• ✅ Code generated\n• ✅ Tests created\n• ✅ Fixes applied\n\nYour project is ready! 🚀`
    : `✅ **Pipeline با موفقیت اجرا شد!**\n\n**🎯 هدف:** ${plan.goal || 'پیاده‌سازی کامل'}\n\n**📦 نتایج Pipeline:**\n• ✅ برنامه‌ریزی کامل (${plan.phases?.length || 0} فاز)\n• ✅ ساختار ساخته شد (${plan.files?.length || 0} فایل)\n• ✅ کد تولید شد\n• ✅ تست‌ها ساخته شدند\n• ✅ اصلاحات اعمال شد\n\nپروژه‌ت آماده است! 🚀`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Return summary ONLY as bullet points. Every line MUST start with "- ". No paragraphs. No JSON/code. Language: ${lang === 'en' ? 'English' : 'Farsi'}. 6-10 bullets max. Mention that full pipeline was executed (planning, scaffolding, codegen, testing, fixing).`
        },
        {
          role: 'user',
          content: `User: "${userMessage}"\n\nPipeline completed. Plan: ${plan.phases?.length || 0} phases, ${plan.files?.length || 0} files.\n\nSummarize briefly.`
        }
      ],
      temperature: 0.2,
      max_tokens: 300,
      stream: true,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    let fullContent = '';
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) fullContent += content;
    }

    const hasBullets = /(^|\n)\s*[-•]\s+/.test(fullContent);
    if (!hasBullets) {
      fullContent = fullContent
        .replace(/\n+/g, ' ')
        .split(/(?<=[.!?])\s+/)
        .filter(Boolean)
        .map(s => `- ${s}`)
        .join('\n');
    }

    reply.raw.write(`data: ${JSON.stringify({ type: 'content', content: fullContent })}\n\n`);
    return fullContent;
  } catch {
    console.log('⚠️  Summary AI failed, using fallback');
    const fallback = createFallbackSummary();
    reply.raw.write(`data: ${JSON.stringify({ type: 'content', content: fallback })}\n\n`);
    return fallback;
  }
}

// --------- SSE Helper ----------
function startSSE(reply) {
  reply.raw.setHeader('Access-Control-Allow-Origin', '*');
  reply.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  reply.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

// --------- Main Route Handler ----------
export default async function (fastify, opts) {

  // --------- POST /run ----------
  fastify.post('/run', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    const { message, session_id } = request.body;

    if (!message || typeof message !== 'string') {
      return reply.code(400).send({ ok: false, error: 'Message is required and must be a string' });
    }

    const sessionId = (typeof session_id === 'string' && session_id.trim())
      ? session_id.trim()
      : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    createSession(sessionId, message.slice(0, 60));
    saveMessage(sessionId, 'user', message);
    touchSession(sessionId);

    try {
      const intent = await classifyIntent(message);
      console.log(`📊 Intent: ${intent.type} (confidence: ${intent.confidence})`);

      const msgId = `msg_${Date.now()}`;
      const timestamp = new Date().toISOString();
      const lang = detectLanguage(message);

      // --------- Crisis ----------
      if (intent.type === 'crisis') {
        startSSE(reply);
        const content = lang === 'en'
          ? "💙 I hear you, and I'm really glad you reached out. Please talk to someone who can help right now:\n\n• **Iran Crisis Line:** ☎️ 1480\n• **International:** https://findahelpline.com\n\nYou don't have to go through this alone. 💙"
          : "💙 می‌فهمم که الان خیلی سخته. لطفاً همین الان با یه متخصص صحبت کن:\n\n• **اورژانس اجتماعی ایران:** ☎️ ۱۲۳\n• **خط بحران:** ☎️ ۱۴۸۰\n\nتنها نیستی. 💙";
        reply.raw.write(`data: ${JSON.stringify({ type: 'start', id: msgId, session_id: sessionId, createdAt: timestamp, metadata: { intent: 'crisis' } })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: 'done', metadata: { type: 'crisis' } })}\n\n`);
        reply.raw.end();
        saveMessage(sessionId, 'assistant', content, 'crisis');
        touchSession(sessionId);
        return reply;
      }

      // --------- Greeting ----------
      if (intent.type === 'greeting') {
        startSSE(reply);
        const content = await generateGreetingResponse(message, sessionId);
        reply.raw.write(`data: ${JSON.stringify({ type: 'start', id: msgId, session_id: sessionId, createdAt: timestamp, metadata: { intent: 'greeting' } })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: 'done', metadata: { type: 'greeting' } })}\n\n`);
        reply.raw.end();
        saveMessage(sessionId, 'assistant', content, 'greeting');
        touchSession(sessionId);
        return reply;
      }

      // --------- Clarification ----------
      if (intent.type === 'clarification') {
        startSSE(reply);
        const content = await generateClarificationResponse(message);
        reply.raw.write(`data: ${JSON.stringify({ type: 'start', id: msgId, session_id: sessionId, createdAt: timestamp, metadata: { intent: 'clarification' } })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: 'done', metadata: { type: 'clarification' } })}\n\n`);
        reply.raw.end();
        saveMessage(sessionId, 'assistant', content, 'clarification');
        touchSession(sessionId);
        return reply;
      }

      // --------- Casual ----------
      if (intent.type === 'casual') {
        startSSE(reply);
        const content = await generateCasualResponse(message);
        reply.raw.write(`data: ${JSON.stringify({ type: 'start', id: msgId, session_id: sessionId, createdAt: timestamp, metadata: { intent: 'casual' } })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: 'done', metadata: { type: 'casual' } })}\n\n`);
        reply.raw.end();
        saveMessage(sessionId, 'assistant', content, 'casual');
        touchSession(sessionId);
        return reply;
      }

      // --------- Technical ----------
      if (intent.type === 'technical') {
        startSSE(reply);
        reply.raw.write(`data: ${JSON.stringify({ type: 'start', id: msgId, session_id: sessionId, createdAt: timestamp, metadata: { intent: intent.type } })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: 'progress', stage: 'pipeline_start', message: lang === 'en' ? '🚀 Starting full development pipeline...' : '🚀 شروع پایپلاین کامل توسعه...' })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: 'progress', stage: 'planning', message: lang === 'en' ? '📋 Phase 1/5: Planning architecture...' : '📋 فاز 1/5: طراحی معماری...' })}\n\n`);

        try {
          await runPipeline(message);
        } catch (pipelineError) {
          reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'Pipeline execution failed', details: pipelineError.message })}\n\n`);
          reply.raw.end();
          saveMessage(sessionId, 'assistant', `Pipeline failed: ${pipelineError.message}`, 'technical');
          touchSession(sessionId);
          return;
        }

        reply.raw.write(`data: ${JSON.stringify({ type: 'progress', stage: 'completed', message: lang === 'en' ? '✅ All phases completed! Preparing summary...' : '✅ همه فازها تکمیل شد! آماده‌سازی خلاصه...' })}\n\n`);

        const plannerPlanPath = path.resolve(__dirname, '../../planner_plan.json');
        let plan = {};
        const latestPlan = 'planner_plan.json';

        try {
          plan = JSON.parse(await fs.readFile(plannerPlanPath, 'utf-8'));
        } catch (err) {
          console.warn('⚠️  Could not read planner_plan.json:', err.message);
        }

        reply.raw.write(`data: ${JSON.stringify({ type: 'plan_metadata', plan_file: latestPlan, plan_path: plannerPlanPath, phases_count: plan.phases?.length || 0, files_count: plan.files?.length || 0, tech_stack: plan.tech_stack || {} })}\n\n`);

        const summary = await streamPlanSummary(plan, message, reply);

        reply.raw.write(`data: ${JSON.stringify({
          type: 'done',
          summary,
          metadata: {
            type: 'pipeline',
            intent: intent.type,
            plan_file: latestPlan,
            plan_path: plannerPlanPath,
            plan_summary: {
              name: plan.name,
              project_type: plan.project_type,
              goal: plan.goal,
              tech_stack: plan.tech_stack,
              phases_count: plan.phases?.length || 0,
              files_count: plan.files?.length || 0,
            },
            plan,
            full_plan_url: `/api/agent/plan/${latestPlan}`
          }
        })}\n\n`);

        reply.raw.end();
        saveMessage(sessionId, 'assistant', summary, 'technical');
        touchSession(sessionId);
        return reply;
      }

      return reply.code(400).send({ ok: false, error: 'Unable to process request', intent: intent.type });

    } catch (error) {
      console.error('❌ Error in agent route:', error);
      if (reply.raw.headersSent) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'Internal server error', details: error.message })}\n\n`);
        reply.raw.end();
      } else {
        return reply.code(500).send({ ok: false, error: 'Internal server error', details: error.message });
      }
    }
  });

  // --------- GET /plan/:filename ----------
  fastify.get('/plan/:filename', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const { filename } = request.params;

    if (!/^planner(_plan|\d+)\.json$/.test(filename)) {
      return reply.code(400).send({ ok: false, error: 'Invalid filename format' });
    }

    const filepath = path.join(PLANS_DIR, filename);
    try {
      const plan = JSON.parse(await fs.readFile(filepath, 'utf-8'));
      return reply.send({ ok: true, plan, filename, filepath });
    } catch (error) {
      if (error.code === 'ENOENT') return reply.code(404).send({ ok: false, error: 'Plan not found' });
      return reply.code(500).send({ ok: false, error: 'Failed to read plan', details: error.message });
    }
  });

  // --------- GET /sessions ----------
  fastify.get('/sessions', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    try {
      const sessions = listSessions();
      return reply.send({ ok: true, sessions });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: 'Failed to list sessions', details: error.message });
    }
  });

  // --------- GET /sessions/:sessionId ----------
  fastify.get('/sessions/:sessionId', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    try {
      const messages = getSessionMessages(request.params.sessionId);
      return reply.send({ ok: true, session_id: request.params.sessionId, messages });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: 'Failed to get session', details: error.message });
    }
  });

  // --------- DELETE /sessions/:sessionId ----------
  fastify.delete('/sessions/:sessionId', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    try {
      deleteSession(request.params.sessionId);
      return reply.send({ ok: true, deleted: request.params.sessionId });
    } catch (error) {
      return reply.code(500).send({ ok: false, error: 'Failed to delete session', details: error.message });
    }
  });
}
