import { runPlanner } from '../../planner_agent.mjs';
import OpenAI from 'openai';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------- OpenAI Config ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "***REMOVED-SECRET***",
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.gapgpt.app/v1',
  timeout: 30000,
  maxRetries: 2,
});

// ✅ Plans directory - مسیر مطلق به ai-sandbox
const PLANS_DIR = '/Users/kkanamanat/Developer/ai-sandbox';

// Ensure plans directory exists
async function ensurePlansDir() {
  try {
    await fs.mkdir(PLANS_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create plans directory:', err);
  }
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

const GREETING_RESPONSES = {
  en: [
    "👋 Hi! I'm your AI project planner. I can help you:\n\n• Design full-stack applications\n• Create REST APIs\n• Build React/Vue dashboards\n• Plan database schemas\n• Architect microservices\n\nWhat would you like to build today?",
    "Hello! Ready to turn your ideas into reality. I specialize in:\n\n• Frontend (React, Vue, Angular)\n• Backend (Node.js, Fastify, Express)\n• Databases (PostgreSQL, MongoDB)\n• API development\n• System architecture\n\nTell me about your project!",
    "Hey there! 🚀 I'm here to help you plan and build software. I can assist with:\n\n• Web applications\n• Mobile backends\n• Data pipelines\n• Authentication systems\n• Cloud infrastructure\n\nWhat's your vision?",
  ],
  fa: [
    "👋 سلام! من planner هوشمند پروژه‌ت هستم. می‌تونم کمکت کنم:\n\n• طراحی اپلیکیشن فول‌استک\n• ساخت REST API\n• ساخت داشبورد React/Vue\n• طراحی schema دیتابیس\n• معماری میکروسرویس\n\nامروز می‌خوای چی بسازیم؟",
    "درود! آماده‌ام ایده‌هات رو به واقعیت تبدیل کنم. تخصص من:\n\n• فرانت‌اند (React, Vue, Angular)\n• بک‌اند (Node.js, Fastify, Express)\n• دیتابیس (PostgreSQL, MongoDB)\n• توسعه API\n• معماری سیستم\n\nدرباره پروژه‌ت بگو!",
    "هی! 🚀 من اینجام تا کمکت کنم نرم‌افزار بسازی. می‌تونم در این زمینه‌ها کمک کنم:\n\n• اپلیکیشن‌های وب\n• بک‌اند موبایل\n• پایپلاین داده\n• سیستم احراز هویت\n• زیرساخت کلود\n\nچشم‌اندازت چیه؟",
  ],
};

// --------- Language Detection ----------
function detectLanguage(text) {
  const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
  const farsiChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return englishChars > farsiChars ? 'en' : 'fa';
}

function isGreeting(message) {
  const trimmed = message.trim();
  return GREETING_PATTERNS.some(pattern => pattern.test(trimmed));
}

function getGreetingResponse(message) {
  const lang = detectLanguage(message);
  const responses = GREETING_RESPONSES[lang];
  return responses[Math.floor(Math.random() * responses.length)];
}

// --------- Intent Classification ----------
async function classifyIntent(message) {
  const trimmed = message.trim();
  
  // 1. Greeting
  if (isGreeting(trimmed)) {
    return { type: 'greeting', confidence: 1.0 };
  }
  
  // 2. Too short/vague
  if (trimmed.length < 15 || trimmed.split(/\s+/).length < 4) {
    return { type: 'casual', confidence: 0.9 };
  }
  
  // 3. Check for technical keywords
  const technicalKeywords = [
    'api', 'backend', 'frontend', 'database', 'auth', 'dashboard',
    'react', 'vue', 'node', 'fastify', 'express', 'postgresql',
    'mongodb', 'microservice', 'rest', 'graphql', 'websocket',
    'دیتابیس', 'بک‌اند', 'فرانت‌اند', 'داشبورد', 'احراز هویت'
  ];
  
  const hasTechnicalKeyword = technicalKeywords.some(kw => 
    trimmed.toLowerCase().includes(kw)
  );
  
  // 4. Check for vague project requests
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
  
  if (isVague && !hasTechnicalKeyword) {
    return { type: 'clarification', confidence: 0.8 };
  }
  
  // 5. Technical request
  if (hasTechnicalKeyword || trimmed.split(/\s+/).length > 10) {
    return { type: 'technical', confidence: 0.9 };
  }
  
  // 6. Default: casual conversation
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
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0.7,
      max_tokens: 200,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.choices[0].message.content;
  } catch (error) {
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
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0.7,
      max_tokens: 120,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.choices[0].message.content;
  } catch (error) {
    console.log('⚠️  Casual response AI failed, using fallback');
    return fallbacks[lang];
  }
}

// --------- Plan Management ----------
async function getNextPlannerFilename() {
  await ensurePlansDir();
  
  let counter = 1;
  let filename = `planner${counter}.json`;
  let filepath = path.join(PLANS_DIR, filename);
  
  while (true) {
    try {
      await fs.access(filepath);
      counter++;
      filename = `planner${counter}.json`;
      filepath = path.join(PLANS_DIR, filename);
    } catch {
      break;
    }
  }
  
  return { filename, filepath };
}

async function savePlanToFile(plan) {
  const { filename, filepath } = await getNextPlannerFilename();
  await fs.writeFile(filepath, JSON.stringify(plan, null, 2), 'utf-8');
  console.log(`💾 Plan saved: ${filepath}`);
  return { filename, filepath };
}

// --------- Stream Plan Summary ----------
async function streamPlanSummary(plan, userMessage, reply) {
  const lang = detectLanguage(userMessage);
  
  const createFallbackSummary = () => {
    if (lang === 'en') {
      return `✅ **Plan Created Successfully!**

I've designed a comprehensive plan for your project:

**🎯 Goal:** ${plan.goal || 'Complete implementation'}

**🛠️ Tech Stack:**
${plan.tech_stack ? Object.entries(plan.tech_stack).filter(([k, v]) => v).slice(0, 4).map(([k, v]) => `• ${k}: ${v}`).join('\n') : '• Modern technologies'}

**📦 Implementation:**
• ${plan.phases?.length || 0} phases
• ${plan.phases?.reduce((sum, p) => sum + (p.steps?.length || 0), 0) || 0} detailed steps
• ${plan.files?.length || 0} files to create

Ready to start building! 🚀`;
    } else {
      return `✅ **Plan با موفقیت ساخته شد!**

یک plan جامع برای پروژه‌ت طراحی کردم:

**🎯 هدف:** ${plan.goal || 'پیاده‌سازی کامل'}

**🛠️ تکنولوژی‌ها:**
${plan.tech_stack ? Object.entries(plan.tech_stack).filter(([k, v]) => v).slice(0, 4).map(([k, v]) => `• ${k}: ${v}`).join('\n') : '• تکنولوژی‌های مدرن'}

**📦 پیاده‌سازی:**
• ${plan.phases?.length || 0} فاز
• ${plan.phases?.reduce((sum, p) => sum + (p.steps?.length || 0), 0) || 0} مرحله دقیق
• ${plan.files?.length || 0} فایل برای ساخت

آماده شروع! 🚀`;
    }
  };
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    
    const stream = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    {
      role: 'system',
      content: `Return summary ONLY as bullet points.
Every line MUST start with "- ".
No paragraphs. No JSON/code.
Language: ${lang === 'en' ? 'English' : 'Farsi'}.
6-10 bullets max.`
    },
    {
      role: 'user',
      content: `User: "${userMessage}"\n\nPlan: ${plan.phases?.length || 0} phases, ${plan.files?.length || 0} files.\n\nSummarize briefly.`
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

// ✅ اینجا تبدیل اجباری به بولت
const hasBullets = /(^|\n)\s*[-•]\s+/.test(fullContent);
if (!hasBullets) {
  const sentences = fullContent
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  fullContent = sentences.map(s => `- ${s}`).join('\n');
}

// بعدش یک‌باره بفرست
reply.raw.write(`data: ${JSON.stringify({ type: 'content', content: fullContent })}\n\n`);

    
    return fullContent;
  } catch (error) {
    console.log('⚠️  Summary AI failed, using fallback');
    const fallback = createFallbackSummary();
    reply.raw.write(`data: ${JSON.stringify({ type: 'content', content: fallback })}\n\n`);
    return fallback;
  }
}


// --------- Main Route Handler ----------
export default async function (fastify, opts) {
  fastify.post('/run', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    const { message } = request.body;

    if (!message || typeof message !== 'string') {
      return reply.code(400).send({ 
        ok: false, 
        error: 'Message is required and must be a string' 
      });
    }

    try {
      const intent = await classifyIntent(message);
      console.log(`📊 Intent: ${intent.type} (confidence: ${intent.confidence})`);
      
      const msgId = `msg_${Date.now()}`;
      const timestamp = new Date().toISOString();
      
      // --------- Handle Greeting (SSE Stream) ----------
      if (intent.type === 'greeting') {
        const lang = detectLanguage(message);
        
        reply.raw.setHeader('Access-Control-Allow-Origin', '*');
        reply.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        reply.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        
        const greetingMsg = getGreetingResponse(message);
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'start',
          id: msgId,
          createdAt: timestamp,
          metadata: { intent: 'greeting' }
        })}\n\n`);
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'content', 
          content: greetingMsg 
        })}\n\n`);
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'done',
          metadata: { type: 'greeting' }
        })}\n\n`);
        
        reply.raw.end();
        return reply;
      }
      
      // --------- Handle Clarification (SSE Stream) ----------
      if (intent.type === 'clarification') {
        const lang = detectLanguage(message);
        
        reply.raw.setHeader('Access-Control-Allow-Origin', '*');
        reply.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        reply.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'start',
          id: msgId,
          createdAt: timestamp,
          metadata: { intent: 'clarification' }
        })}\n\n`);
        
        const clarification = await generateClarificationResponse(message);
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'content', 
          content: clarification 
        })}\n\n`);
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'done',
          metadata: { type: 'clarification' }
        })}\n\n`);
        
        reply.raw.end();
        return reply;
      }
      
      // --------- Handle Casual (SSE Stream) ----------
      if (intent.type === 'casual') {
        const lang = detectLanguage(message);
        
        reply.raw.setHeader('Access-Control-Allow-Origin', '*');
        reply.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        reply.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'start',
          id: msgId,
          createdAt: timestamp,
          metadata: { intent: 'casual' }
        })}\n\n`);
        
        const casual = await generateCasualResponse(message);
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'content', 
          content: casual 
        })}\n\n`);
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'done',
          metadata: { type: 'casual' }
        })}\n\n`);
        
        reply.raw.end();
        return reply;
      }
      
      // --------- Handle Technical (Stream Response) ----------
      if (intent.type === 'technical') {
        const lang = detectLanguage(message);
        
        reply.raw.setHeader('Access-Control-Allow-Origin', '*');
        reply.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        reply.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'start',
          id: msgId,
          createdAt: timestamp,
          metadata: { intent: intent.type }
        })}\n\n`);
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'progress',
          stage: 'analyzing',
          message: lang === 'en' 
            ? '🧠 Analyzing your request and designing architecture...'
            : '🧠 در حال تحلیل درخواست و طراحی معماری...'
        })}\n\n`);
        
        let plan;
        try {
          plan = await runPlanner(message);
        } catch (plannerError) {
          reply.raw.write(`data: ${JSON.stringify({ 
            type: 'error',
            error: 'Failed to generate plan',
            details: plannerError.message
          })}\n\n`);
          reply.raw.end();
          return;
        }
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'progress',
          stage: 'saving',
          message: lang === 'en'
            ? '✅ Architecture designed! Saving plan...'
            : '✅ معماری طراحی شد! در حال ذخیره...'
        })}\n\n`);
        
        const { filename, filepath } = await savePlanToFile(plan);
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'plan_metadata',
          plan_file: filename,
          plan_path: filepath,
          phases_count: plan.phases?.length || 0,
          files_count: plan.files?.length || 0,
          tech_stack: plan.tech_stack || {}
        })}\n\n`);
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'progress',
          stage: 'summarizing',
          message: lang === 'en'
            ? '📝 Preparing summary...'
            : '📝 در حال آماده‌سازی خلاصه...'
        })}\n\n`);
        
        const summary = await streamPlanSummary(plan, message, reply);
        
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'done',
          summary,
          metadata: {
            type: 'plan',
            intent: intent.type,
            plan_file: filename,
            plan_path: filepath,
            plan_summary: {
              name: plan.name,
              project_type: plan.project_type,
              goal: plan.goal,
              tech_stack: plan.tech_stack,
              phases_count: plan.phases?.length || 0,
              files_count: plan.files?.length || 0,
            },
            plan: plan, // ✅ اضافه شد برای دکمه JSON
            full_plan_url: `/api/agent/plan/${filename}`
          }
        })}\n\n`);
        
        reply.raw.end();
        return reply;
      }
      
      return reply.code(400).send({
        ok: false,
        error: 'Unable to process request',
        intent: intent.type
      });
      
    } catch (error) {
      console.error('❌ Error in agent route:', error);
      
      if (reply.raw.headersSent) {
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'error',
          error: 'Internal server error',
          details: error.message
        })}\n\n`);
        reply.raw.end();
      } else {
        return reply.code(500).send({
          ok: false,
          error: 'Internal server error',
          details: error.message,
        });
      }
    }
  });
  
  // --------- Get Full Plan Endpoint ----------
  fastify.get('/plan/:filename', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    
    const { filename } = request.params;
    
    if (!/^planner\d+\.json$/.test(filename)) {
      return reply.code(400).send({ 
        ok: false, 
        error: 'Invalid filename format' 
      });
    }
    
    const filepath = path.join(PLANS_DIR, filename);
    
    try {
      const content = await fs.readFile(filepath, 'utf-8');
      const plan = JSON.parse(content);
      
      return reply.send({
        ok: true,
        plan,
        filename,
        filepath
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return reply.code(404).send({ 
          ok: false, 
          error: 'Plan not found' 
        });
      }
      
      return reply.code(500).send({
        ok: false,
        error: 'Failed to read plan',
        details: error.message
      });
    }
  });
  
  // --------- List All Plans Endpoint ----------
  fastify.get('/plans', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    
    await ensurePlansDir();
    
    try {
      const files = await fs.readdir(PLANS_DIR);
      const planFiles = files.filter(f => /^planner\d+\.json$/.test(f));
      
      const plans = await Promise.all(
        planFiles.map(async (filename) => {
          try {
            const filepath = path.join(PLANS_DIR, filename);
            const content = await fs.readFile(filepath, 'utf-8');
            const plan = JSON.parse(content);
            const stats = await fs.stat(filepath);
            
            return {
              filename,
              name: plan.name,
              project_type: plan.project_type,
              goal: plan.goal,
              created_at: stats.birthtime,
              size: stats.size
            };
          } catch {
            return null;
          }
        })
      );
      
      return reply.send({
        ok: true,
        plans: plans.filter(Boolean).sort((a, b) => 
          new Date(b.created_at) - new Date(a.created_at)
        )
      });
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'Failed to list plans',
        details: error.message
      });
    }
  });
}
