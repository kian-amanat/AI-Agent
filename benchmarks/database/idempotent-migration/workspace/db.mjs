/** A tiny stand-in for a real database. Throws like one would. */
export function createDb() {
  const tables = new Map();
  return {
    tables,
    createTable(name, columns) {
      if (tables.has(name)) throw new Error(`table ${name} already exists`);
      tables.set(name, { columns: [...columns], rows: [] });
    },
    addColumn(table, column) {
      const t = tables.get(table);
      if (!t) throw new Error(`no such table ${table}`);
      if (t.columns.includes(column)) throw new Error(`duplicate column ${column}`);
      t.columns.push(column);
    },
    hasTable(name) { return tables.has(name); },
    hasColumn(table, column) { return !!tables.get(table)?.columns.includes(column); },
    insert(table, row) { tables.get(table).rows.push(row); },
    count(table) { return tables.get(table)?.rows.length ?? 0; },
  };
}
