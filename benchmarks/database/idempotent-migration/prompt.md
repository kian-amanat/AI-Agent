The migration in `migrate.mjs` crashes when it runs twice. Make it idempotent — running it repeatedly must be safe — without losing existing rows.
