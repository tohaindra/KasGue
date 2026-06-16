import { ensureSchema, getDb } from "../src/db.js";
import { backupDatabase } from "./backup-db.js";

await backupDatabase();
const db = await getDb();

try {
  await ensureSchema(db);
  console.log("Database migration completed.");
} finally {
  await db.end();
}
