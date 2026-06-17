import db from "../db.mjs";

// --- Schema ensure + lightweight migration for existing DBs ---
function ensureSessionMemorySchema() {
  // 1) جدول را اگر نیست، با اسکیما کامل بساز
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_memory (
      session_id TEXT PRIMARY KEY,

      last_task TEXT,
      last_task_type TEXT,
      last_project_scope TEXT,

      last_target_file TEXT,
      last_target_component TEXT,

      last_attachment_paths TEXT,

      last_user_message TEXT,
      last_assistant_message TEXT,

      updated_at TEXT NOT NULL
    );
  `);

  // 2) برای DBهای قدیمی، ستون‌های جدید را در صورت نبودن اضافه کن
  const columns = db
    .prepare("PRAGMA table_info(session_memory);")
    .all()
    .map((col) => col.name);

  const ensureColumn = (name, type) => {
    if (!columns.includes(name)) {
      db.prepare(`ALTER TABLE session_memory ADD COLUMN ${name} ${type};`).run();
    }
  };

  // این‌ها در اسکیما جدید باید وجود داشته باشند
  ensureColumn("last_task", "TEXT");
  ensureColumn("last_task_type", "TEXT");
  ensureColumn("last_project_scope", "TEXT");
  ensureColumn("last_target_file", "TEXT");
  ensureColumn("last_target_component", "TEXT");
  ensureColumn("last_attachment_paths", "TEXT");
  ensureColumn("last_user_message", "TEXT");
  ensureColumn("last_assistant_message", "TEXT");

  // اگر می‌خواهی برای DB خیلی قدیمی که حتی updated_at ندارد هم safe باشی:
  // توجه: چون updated_at در تعریف اصلی NOT NULL است، اضافه کردنش به جدول قدیمی
  // عملاً آن را nullable می‌کند (SQLite constraint را روی داده‌ی موجود enforce نمی‌کند).
  // اگر لازم شد، می‌توانی این خط را هم فعال کنی:
  //
  // ensureColumn("updated_at", "TEXT");
}

// حتماً هنگام لود این ماژول، اسکیما را تنظیم/مهاجرت بده
ensureSessionMemorySchema();

// --- Helpers ---

function safeParseArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeArrayInput(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item || "").trim())
          .filter(Boolean);
      }
    } catch {
      // ignore JSON parsing errors
    }

    return trimmed
      .split(/[,\n;]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

// --- Core API ---

export function getMemory(sessionId) {
  if (!sessionId) return null;

  const row = db
    .prepare(
      `
      SELECT *
      FROM session_memory
      WHERE session_id = ?
    `
    )
    .get(sessionId);

  if (!row) {
    return null;
  }

  return {
    ...row,
    last_attachment_paths: safeParseArray(row.last_attachment_paths),
  };
}

export function upsertMemory(sessionId, updates = {}) {
  if (!sessionId) return null;

  const existing = getMemory(sessionId);

  const lastAttachmentPaths = normalizeArrayInput(
    updates.last_attachment_paths ?? existing?.last_attachment_paths ?? []
  );

  const memory = {
    last_task: updates.last_task ?? existing?.last_task ?? null,
    last_task_type: updates.last_task_type ?? existing?.last_task_type ?? null,
    last_project_scope:
      updates.last_project_scope ?? existing?.last_project_scope ?? null,
    last_target_file:
      updates.last_target_file ?? existing?.last_target_file ?? null,
    last_target_component:
      updates.last_target_component ?? existing?.last_target_component ?? null,
    last_attachment_paths: JSON.stringify(lastAttachmentPaths),
    last_user_message:
      updates.last_user_message ?? existing?.last_user_message ?? null,
    last_assistant_message:
      updates.last_assistant_message ??
      existing?.last_assistant_message ??
      null,
  };

  db.prepare(
    `
    INSERT INTO session_memory (
      session_id,
      last_task,
      last_task_type,
      last_project_scope,
      last_target_file,
      last_target_component,
      last_attachment_paths,
      last_user_message,
      last_assistant_message,
      updated_at
    )
    VALUES (
      @session_id,
      @last_task,
      @last_task_type,
      @last_project_scope,
      @last_target_file,
      @last_target_component,
      @last_attachment_paths,
      @last_user_message,
      @last_assistant_message,
      @updated_at
    )
    ON CONFLICT(session_id)
    DO UPDATE SET
      last_task = excluded.last_task,
      last_task_type = excluded.last_task_type,
      last_project_scope = excluded.last_project_scope,
      last_target_file = excluded.last_target_file,
      last_target_component = excluded.last_target_component,
      last_attachment_paths = excluded.last_attachment_paths,
      last_user_message = excluded.last_user_message,
      last_assistant_message = excluded.last_assistant_message,
      updated_at = excluded.updated_at
  `
  ).run({
    session_id: sessionId,
    updated_at: new Date().toISOString(),
    ...memory,
  });

  return getMemory(sessionId);
}

export function clearMemory(sessionId) {
  if (!sessionId) return;

  db.prepare(
    `
    DELETE FROM session_memory
    WHERE session_id = ?
  `
  ).run(sessionId);
}

// --- Convenience helpers ---

export function rememberUserMessage(sessionId, message) {
  return upsertMemory(sessionId, {
    last_user_message: message,
  });
}

export function rememberAssistantMessage(sessionId, message) {
  return upsertMemory(sessionId, {
    last_assistant_message: message,
  });
}

export function rememberFiles(sessionId, filePaths = []) {
  return upsertMemory(sessionId, {
    last_attachment_paths: filePaths,
  });
}

export function rememberTargetFile(sessionId, filePath) {
  return upsertMemory(sessionId, {
    last_target_file: filePath,
  });
}

export function rememberTargetComponent(sessionId, componentName) {
  return upsertMemory(sessionId, {
    last_target_component: componentName,
  });
}

export function rememberTask(
  sessionId,
  {
    task,
    taskType,
    projectScope,
  } = {}
) {
  return upsertMemory(sessionId, {
    last_task: task,
    last_task_type: taskType,
    last_project_scope: projectScope,
  });
}

export function getMemoryContext(sessionId) {
  const memory = getMemory(sessionId);
  if (!memory) return "";

  const lines = [];

  if (memory.last_task) lines.push(`LAST TASK: ${memory.last_task}`);
  if (memory.last_task_type)
    lines.push(`LAST TASK TYPE: ${memory.last_task_type}`);
  if (memory.last_project_scope) {
    lines.push(`LAST PROJECT SCOPE: ${memory.last_project_scope}`);
  }

  if (memory.last_target_file) {
    lines.push(`LAST TARGET FILE: ${memory.last_target_file}`);
  }

  if (memory.last_target_component) {
    lines.push(`LAST TARGET COMPONENT: ${memory.last_target_component}`);
  }

  if (
    Array.isArray(memory.last_attachment_paths) &&
    memory.last_attachment_paths.length
  ) {
    lines.push(`LAST ATTACHMENTS: ${memory.last_attachment_paths.join(", ")}`);
  }

  if (memory.last_user_message) {
    lines.push(`LAST USER MESSAGE: ${memory.last_user_message}`);
  }

  if (memory.last_assistant_message) {
    lines.push(`LAST ASSISTANT MESSAGE: ${memory.last_assistant_message}`);
  }

  return lines.join("\n").trim();
}
