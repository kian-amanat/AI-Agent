// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",   // مسیر فایل، نه *schema import
  out: "./drizzle",

  // برای sqlite محلی
  dbCredentials: {
    url: "./sqlite.db",
  },
});
