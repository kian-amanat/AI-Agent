/** Creates the users table and adds the email column. */
export function migrate(db) {
  db.createTable("users", ["id", "name"]);
  db.addColumn("users", "email");
}
