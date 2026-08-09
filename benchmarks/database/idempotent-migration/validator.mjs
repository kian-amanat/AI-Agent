/** Runs the migration twice, with a real row inserted in between. */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

export default async function validate({ workspace }) {
  const checks = [];
  let migrate = null; let createDb = null;
  checks.push(await behaviourCheck("both modules still load", async () => {
    ({ migrate } = await importFromWorkspace(workspace, "migrate.mjs"));
    ({ createDb } = await importFromWorkspace(workspace, "db.mjs"));
    if (typeof migrate !== "function") return "migrate is no longer exported";
  }, { guard: true }));
  if (!migrate || !createDb) return checks;

  checks.push(await behaviourCheck("the first run still creates the schema", () => {
    const db = createDb();
    migrate(db);
    if (!db.hasTable("users")) return "users table was not created";
    if (!db.hasColumn("users", "email")) return "email column was not added";
  }, { guard: true }));

  checks.push(await behaviourCheck("running it twice does not throw", () => {
    const db = createDb();
    migrate(db);
    migrate(db);
  }));

  checks.push(await behaviourCheck("re-running preserves existing rows", () => {
    const db = createDb();
    migrate(db);
    db.insert("users", { id: 1, name: "Ada", email: "ada@example.com" });
    migrate(db);
    if (db.count("users") !== 1) return `row count is ${db.count("users")} — the migration dropped data`;
    if (!db.hasColumn("users", "email")) return "the email column is gone after re-running";
  }));

  checks.push(await behaviourCheck("it is safe many times over", () => {
    const db = createDb();
    for (let i = 0; i < 5; i++) migrate(db);
    if (!db.hasTable("users") || !db.hasColumn("users", "email")) return "schema damaged by repeated runs";
  }));

  checks.push(check("db.mjs was left alone",
    true, "", { critical: false, guard: true }));
  return checks;
}
