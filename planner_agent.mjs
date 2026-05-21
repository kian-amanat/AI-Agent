import path from "path";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import OpenAI from "openai";

import { listBackendFiles } from "./tools/list_backend_files.js";
import { readProjectFile } from "./tools/readProjectFile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------- Config ----------
const PROJECT_ROOT = process.cwd();
const BACKEND_ROOT = path.join(PROJECT_ROOT, "backend");
const FRONTEND_ROOT = path.join(PROJECT_ROOT, "frontend"); // اضافه شد
const BACKEND_CWD_REL = path.relative(PROJECT_ROOT, BACKEND_ROOT) || "backend";
const FRONTEND_CWD_REL = path.relative(PROJECT_ROOT, FRONTEND_ROOT) || "frontend";

const FRONTEND_AUTH_CONTRACT_PATH = path.join(PROJECT_ROOT, "API", "api1.ts");

// Model/baseURL/key
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.gapgpt.app/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "***REMOVED-SECRET***";

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY env var.");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
});

// --------- Detect intent: frontend vs backend vs both ----------
function detectProjectScope(userMessage) {
  const msg = userMessage.toLowerCase();
  
  const frontendKeywords = ['frontend', 'front-end', 'ui', 'react', 'vue', 'component', 'page', 'routing', 'state management'];
  const backendKeywords = ['backend', 'back-end', 'api', 'server', 'database', 'auth', 'fastify', 'express', 'endpoint', 'route'];
  
  const hasFrontend = frontendKeywords.some(kw => msg.includes(kw));
  const hasBackend = backendKeywords.some(kw => msg.includes(kw));
  
  if (hasFrontend && hasBackend) return 'fullstack';
  if (hasFrontend) return 'frontend';
  if (hasBackend) return 'backend';
  
  // اگه مشخص نبود، از AI بپرس
  return 'auto'; // بعداً AI تشخیص می‌ده
}

// --------- Dynamic System Prompt Generator ----------
// --------- Dynamic System Prompt Generator (Enhanced) ----------
function generateSystemPrompt(scope) {
  const basePrompt = `
You are a **Senior Software Architect** with 15+ years of experience.
Your job is to design a **production-ready project plan** using the latest technologies and best engineering practices.

**Output Format:**
- ONLY valid JSON (no markdown, no explanations, no \`\`\`)
- Structure:

{
  "name": string,
  "project_type": "frontend" | "backend" | "fullstack",
  "ready_for_user_review": boolean,
  "goal": string,
  "tech_stack": {
    "runtime": string,
    "language": string,
    "framework": string,
    "orm": string (backend only),
    "db": string (backend only),
    "state_management": string (frontend only),
    "styling": string (frontend only),
    "testing": string,
    "tooling": string,
    "ci_cd": string,
    "monitoring": string
  },
  "architecture": {
    "pattern": string,
    "layers": string[],
    "principles": string[]
  },
  "phases": [
    {
      "id": string,
      "name": string,
      "description": string,
      "steps": [
        {
          "id": string,
          "description": string,
          "files": string[],
          "dependencies": string[],
          "priority": "high" | "medium" | "low",
          "estimated_time": string
        }
      ]
    }
  ],
  "files": [
    {
      "path": string,
      "purpose": string,
      "key_responsibilities": string[]
    }
  ],
  "quality_gates": {
    "code_coverage": string,
    "performance_budget": string,
    "security_checks": string[]
  },
  "notes": string
}

**Core Principles:**
1. **Separation of Concerns**: Clear boundaries between layers
2. **SOLID Principles**: Single responsibility, Open/closed, etc.
3. **DRY (Don't Repeat Yourself)**: Reusable components/modules
4. **Testability**: Easy to unit test, integration test, e2e test
5. **Scalability**: Can handle growth in users/data
6. **Security First**: Input validation, auth, CORS, rate limiting
7. **Performance**: Lazy loading, caching, optimization
8. **Maintainability**: Clear naming, documentation, type safety
`;

  const scopeSpecificRules = {
    frontend: `
**Frontend Architecture (Latest 2025 Standards):**

**Tech Stack:**
- Runtime: Bun 1.1+ (fastest JS runtime)
- Language: TypeScript 5.5+ (strict mode)
- Framework: React 19 (with Server Components) OR Vue 3.5 (Composition API)
- State Management: Zustand 5.0 (lightweight) OR TanStack Query (server state)
- Routing: TanStack Router (type-safe) OR React Router 7
- Styling: Tailwind CSS 4.0 (with CSS variables) + shadcn/ui
- Forms: React Hook Form + Zod validation
- Testing: Vitest + Testing Library + Playwright
- Build: Vite 6.0 (with SWC)
- Linting: Biome (replaces ESLint + Prettier)
- CI/CD: GitHub Actions with Vercel/Netlify
- Monitoring: Sentry + Web Vitals

**Architecture Pattern:**
- Feature-based folder structure (not by type)
- Atomic Design for components (atoms, molecules, organisms)
- Custom hooks for business logic
- Context + Zustand for global state
- React Query for server state (no Redux needed)

**Folder Structure:**
\`\`\`
frontend/
├── src/
│   ├── app/                    # App-level config
│   │   ├── providers/          # Context providers
│   │   ├── router/             # Route definitions
│   │   └── styles/             # Global styles
│   ├── features/               # Feature modules
│   │   ├── auth/
│   │   │   ├── api/            # API calls
│   │   │   ├── components/     # Feature components
│   │   │   ├── hooks/          # Custom hooks
│   │   │   ├── stores/         # Zustand stores
│   │   │   ├── types/          # TypeScript types
│   │   │   └── utils/          # Helper functions
│   │   └── dashboard/
│   ├── shared/                 # Shared across features
│   │   ├── components/         # UI components (shadcn)
│   │   ├── hooks/              # Reusable hooks
│   │   ├── lib/                # Utilities
│   │   └── types/              # Global types
│   ├── pages/                  # Route pages
│   └── main.tsx
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── public/
├── biome.json
├── vite.config.ts
└── tsconfig.json
\`\`\`

**Key Steps:**
1. **Phase 1: Foundation**
   - Setup Vite + TypeScript + Biome
   - Configure path aliases (@/, @shared/, @features/)
   - Setup Tailwind + shadcn/ui
   - Create base layout components

2. **Phase 2: Core Features**
   - Implement routing (TanStack Router)
   - Setup auth flow (login, register, protected routes)
   - Create reusable form components (React Hook Form + Zod)
   - Setup API client (Axios/Fetch with interceptors)

3. **Phase 3: State Management**
   - Setup Zustand stores (auth, user, theme)
   - Setup TanStack Query (queries, mutations, cache)
   - Implement optimistic updates

4. **Phase 4: Testing & Quality**
   - Unit tests for hooks/utils (Vitest)
   - Component tests (Testing Library)
   - E2E tests (Playwright)
   - Setup CI/CD pipeline

5. **Phase 5: Performance & Monitoring**
   - Code splitting (React.lazy)
   - Image optimization
   - Setup Sentry error tracking
   - Web Vitals monitoring

**Quality Gates:**
- Code coverage: >80%
- Performance: Lighthouse score >90
- Accessibility: WCAG 2.1 AA
- Bundle size: <200KB (gzipped)
`,

    backend: `
**Backend Architecture (Latest 2025 Standards):**

**Tech Stack:**
- Runtime: Bun 1.1+ (fastest, built-in TypeScript)
- Language: TypeScript 5.5+ (strict mode)
- Framework: Fastify 5.0 (fastest Node.js framework)
- ORM: Drizzle ORM 0.36+ (type-safe, performant)
- Database: PostgreSQL 17 (with pgvector for AI) OR Turso (SQLite edge)
- Validation: Zod 3.23+
- Auth: Lucia Auth (modern, type-safe) OR Clerk
- Testing: Vitest + Supertest
- API Docs: Scalar (OpenAPI 3.1)
- Caching: Redis 7.4 (with RedisJSON)
- Queue: BullMQ (Redis-based)
- Logging: Pino (fastest logger)
- Monitoring: Grafana + Prometheus
- CI/CD: GitHub Actions + Docker

**Architecture Pattern:**
- Clean Architecture (Hexagonal)
- Domain-Driven Design (DDD) for complex domains
- CQRS (Command Query Responsibility Segregation) if needed
- Event-Driven Architecture for async operations

**Folder Structure:**
\`\`\`
backend/
├── src/
│   ├── app.ts                  # Fastify app setup
│   ├── server.ts               # Server entry point
│   ├── config/                 # Configuration
│   │   ├── env.ts              # Environment variables (Zod validated)
│   │   └── database.ts         # DB connection
│   ├── modules/                # Feature modules (DDD)
│   │   ├── auth/
│   │   │   ├── domain/         # Entities, value objects
│   │   │   ├── application/    # Use cases, DTOs
│   │   │   ├── infrastructure/ # Repositories, external services
│   │   │   └── presentation/   # Routes, controllers
│   │   └── users/
│   ├── shared/                 # Shared kernel
│   │   ├── domain/             # Base entities, errors
│   │   ├── infrastructure/     # DB, cache, queue
│   │   └── utils/              # Helpers
│   ├── db/
│   │   ├── schema/             # Drizzle schemas
│   │   ├── migrations/         # SQL migrations
│   │   └── seed.ts             # Seed data
│   └── plugins/                # Fastify plugins
│       ├── auth.ts
│       ├── cors.ts
│       └── rate-limit.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── drizzle.config.ts
└── tsconfig.json
\`\`\`

**Key Steps:**
1. **Phase 1: Foundation**
   - Setup Bun + TypeScript + Fastify
   - Configure environment variables (Zod validation)
   - Setup Drizzle ORM + PostgreSQL
   - Create base error handling middleware

2. **Phase 2: Core Infrastructure**
   - Setup authentication (Lucia Auth + JWT)
   - Implement RBAC (Role-Based Access Control)
   - Setup Redis caching layer
   - Configure CORS, rate limiting, helmet

3. **Phase 3: Domain Logic**
   - Design database schema (Drizzle)
   - Implement repositories (Repository pattern)
   - Create use cases (business logic)
   - Setup validation (Zod schemas)

4. **Phase 4: API Layer**
   - Create RESTful routes (Fastify)
   - Implement request/response DTOs
   - Setup OpenAPI documentation (Scalar)
   - Add request logging (Pino)

5. **Phase 5: Advanced Features**
   - Setup background jobs (BullMQ)
   - Implement event bus (for microservices)
   - Add full-text search (PostgreSQL FTS)
   - Setup file uploads (S3/R2)

6. **Phase 6: Testing & Deployment**
   - Unit tests (Vitest)
   - Integration tests (Supertest)
   - E2E tests (API testing)
   - Docker containerization
   - CI/CD pipeline (GitHub Actions)
   - Setup monitoring (Grafana + Prometheus)

**Quality Gates:**
- Code coverage: >85%
- API response time: <100ms (p95)
- Security: OWASP Top 10 compliance
- Uptime: 99.9% SLA
`,

    fullstack: `
**Fullstack Architecture (Latest 2025 Standards):**

**Monorepo Structure:**
- Tool: Turborepo (fastest monorepo tool)
- Package Manager: pnpm (efficient, fast)

**Tech Stack:**
- **Frontend**: React 19 + Vite + Tailwind + shadcn/ui
- **Backend**: Fastify + Drizzle ORM + PostgreSQL
- **Shared**: TypeScript types, Zod schemas, utilities
- **API Contract**: tRPC (end-to-end type safety) OR OpenAPI

**Folder Structure:**
\`\`\`
project/
├── apps/
│   ├── web/                    # Frontend (React)
│   └── api/                    # Backend (Fastify)
├── packages/
│   ├── shared/                 # Shared types, utils
│   ├── ui/                     # Shared UI components
│   └── config/                 # Shared configs (TS, ESLint)
├── docker/
│   └── docker-compose.yml      # PostgreSQL, Redis
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
\`\`\`

**Communication:**
- **Option 1**: tRPC (type-safe RPC, no code generation)
- **Option 2**: REST API with OpenAPI + generated TypeScript client

**Key Steps:**
1. **Phase 1: Monorepo Setup**
   - Setup Turborepo + pnpm workspaces
   - Create shared packages (types, ui, config)
   - Configure TypeScript project references

2. **Phase 2: Backend Foundation**
   - Setup Fastify + Drizzle + PostgreSQL
   - Implement auth system (Lucia Auth)
   - Create API routes (RESTful or tRPC)

3. **Phase 3: Frontend Foundation**
   - Setup React + Vite + Tailwind
   - Configure API client (tRPC client or Axios)
   - Implement auth flow (login, register, protected routes)

4. **Phase 4: Feature Development**
   - Build features in parallel (frontend + backend)
   - Share types between apps (via shared package)
   - Implement real-time features (WebSocket/SSE)

5. **Phase 5: Integration & Testing**
   - E2E tests (Playwright with both apps running)
   - Integration tests (API + DB)
   - Setup CI/CD for monorepo (Turborepo cache)

6. **Phase 6: Deployment**
   - Frontend: Vercel/Netlify
   - Backend: Railway/Fly.io/AWS
   - Database: Supabase/Neon/AWS RDS
   - Setup monitoring (Sentry + Grafana)

**Quality Gates:**
- Type safety: 100% (no 'any' types)
- Code coverage: >80%
- API response time: <100ms
- Frontend performance: Lighthouse >90
- Security: OWASP compliance
`,
  };

  return basePrompt + (scopeSpecificRules[scope] || scopeSpecificRules.fullstack);
}


// --------- Summarize project structure ----------
async function summarizeProjectStructure(scope) {
  const summary = { backend: '', frontend: '' };
  
  if (scope === 'backend' || scope === 'fullstack' || scope === 'auto') {
    try {
      const res = await listBackendFiles({ dir: BACKEND_CWD_REL });
      if (res?.success && Array.isArray(res.files)) {
        const lines = res.files.map(e => `${e.is_dir ? 'DIR ' : 'FILE'}: ${e.path}`);
        summary.backend = lines.length ? lines.join('\n') : '<backend dir is empty>';
      } else {
        summary.backend = '<backend dir is empty>';
      }
    } catch (e) {
      summary.backend = `<error: ${String(e)}>`;
    }
  }
  
  if (scope === 'frontend' || scope === 'fullstack' || scope === 'auto') {
    try {
      // فرض می‌کنیم تابع مشابهی برای frontend داریم یا از همون استفاده می‌کنیم
      const res = await listBackendFiles({ dir: FRONTEND_CWD_REL });
      if (res?.success && Array.isArray(res.files)) {
        const lines = res.files.map(e => `${e.is_dir ? 'DIR ' : 'FILE'}: ${e.path}`);
        summary.frontend = lines.length ? lines.join('\n') : '<frontend dir is empty>';
      } else {
        summary.frontend = '<frontend dir is empty>';
      }
    } catch (e) {
      summary.frontend = `<error: ${String(e)}>`;
    }
  }
  
  return summary;
}

// --------- Read frontend contract ----------
async function readFrontendContractSnippet() {
  try {
    if (!fs.existsSync(FRONTEND_AUTH_CONTRACT_PATH)) {
      return "<API/api1.ts not found>";
    }
    const res = await readProjectFile({ path: FRONTEND_AUTH_CONTRACT_PATH });
    const content = typeof res === "string" ? res : res?.content || "";
    return content ? content.slice(0, 2000) : "<API/api1.ts empty>";
  } catch (e) {
    return `<error: ${String(e)}>`;
  }
}

// --------- Utility: safe JSON parse ----------
function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function extractLikelyJsonObject(raw) {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return raw.slice(first, last + 1);
}

// --------- Core planner (dynamic) ----------
async function runPlanner(userMessage) {
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    throw new Error('userMessage is required');
  }

  console.log("🧠 Planner started...");
  console.log("Project root:", PROJECT_ROOT);
  console.log("Goal:", userMessage);

  // 1. تشخیص scope
  let scope = detectProjectScope(userMessage);
  console.log("📊 Detected scope:", scope);

  // 2. اگه auto بود، از AI بپرس
  if (scope === 'auto') {
    const scopeDetectionResp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are a project scope detector. Given a user request, determine if it is "frontend", "backend", or "fullstack". Reply with ONLY one word: frontend, backend, or fullstack.'
        },
        { role: 'user', content: userMessage }
      ],
      temperature: 0,
      max_tokens: 10,
    });
    
    const detectedScope = scopeDetectionResp.choices?.[0]?.message?.content?.trim().toLowerCase();
    scope = ['frontend', 'backend', 'fullstack'].includes(detectedScope) ? detectedScope : 'fullstack';
    console.log("🤖 AI detected scope:", scope);
  }

  // 3. خواندن ساختار پروژه
  const projectStructure = await summarizeProjectStructure(scope);
  const frontendContract = await readFrontendContractSnippet();

  // 4. ساخت system prompt
  const systemPrompt = generateSystemPrompt(scope);

  // 5. ساخت user prompt
  const userPrompt = `
درخواست کاربر:
${userMessage}

نوع پروژه: ${scope}

${projectStructure.backend ? `وضعیت فعلی backend/:\n${projectStructure.backend}\n` : ''}
${projectStructure.frontend ? `وضعیت فعلی frontend/:\n${projectStructure.frontend}\n` : ''}
${frontendContract !== '<API/api1.ts not found>' ? `\nAPI Contract (API/api1.ts):\n${frontendContract}` : ''}

وظیفه:
- یک plan کامل ${scope === 'fullstack' ? 'برای frontend و backend' : `برای ${scope}`} طراحی کن
- plan باید شامل phases, steps, files, tech_stack باشد
- مطمئن شو که با درخواست کاربر کاملاً align باشد
`.trim();

  // 6. فراخوانی AI
  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
  });

  const raw = resp.choices?.[0]?.message?.content || "";

  // 7. Parse JSON
  let parsed = safeJsonParse(raw);
  if (!parsed.ok) {
    const candidate = extractLikelyJsonObject(raw);
    if (candidate) parsed = safeJsonParse(candidate);
  }

  if (!parsed.ok) {
    console.error("❌ Planner returned non-JSON. Raw:");
    console.error(raw);
    throw parsed.error;
  }

  const plan = parsed.value;

  // 8. ذخیره plan
  console.log("\n📋 Generated Plan (JSON):\n");
  console.log(JSON.stringify(plan, null, 2));

  const outPath = path.join(PROJECT_ROOT, "planner_plan.json");
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), "utf8");
  console.log(`\n💾 Plan saved to: ${outPath}`);

  return plan;
}

// اجرای مستقیم
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cliGoal = process.argv.slice(2).join(" ");
  if (!cliGoal) {
    console.error("Usage: node planner.js <your request>");
    process.exit(1);
  }
  runPlanner(cliGoal).catch((err) => {
    console.error("❌ Planner crashed:", err);
    process.exit(1);
  });
}

export { runPlanner };
