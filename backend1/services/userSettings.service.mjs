/**
 * services/userSettings.service.mjs
 * Single source of truth for reading a user's model/API-key settings.
 *
 * Each user's key/model lives ONLY in their own `user_settings` row. The
 * legacy single-file store (`data/settings.json`, from before multi-user
 * accounts existed) is migrated ONCE, and ONLY into the very first account
 * ever created on this install — never into a later signup — so a new user
 * (e.g. a family member trying Kodo) never silently starts chatting on the
 * original owner's API key.
 *
 * Previously routes/plannerAgent.mjs had its own copy of this that fell back
 * to the shared file on EVERY request for any user without a row (not just
 * once, and without ever persisting into their row) — meaning every message
 * from an unconfigured user quietly spent the original owner's key.
 */

import fs from "fs/promises";
import path from "path";
import db, { getUserSettings, saveUserSettings, userHasSettings } from "../db.mjs";

const LEGACY_SETTINGS_PATH = path.join(process.cwd(), "data", "settings.json");

function isOriginalUser(userId) {
  const row = db.prepare("SELECT MIN(id) AS minId FROM users").get();
  return row?.minId != null && row.minId === userId;
}

async function loadLegacyGlobalSettings() {
  try {
    return JSON.parse(await fs.readFile(LEGACY_SETTINGS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export async function loadUserSettings(userId) {
  if (!userId) return null;
  const existing = getUserSettings(userId);
  if (existing) return existing;

  if (!userHasSettings(userId) && isOriginalUser(userId)) {
    const legacy = await loadLegacyGlobalSettings();
    if (legacy) {
      saveUserSettings(userId, legacy);
      return legacy;
    }
  }
  return null;
}
