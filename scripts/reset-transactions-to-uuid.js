import { backupDatabase } from "./backup-db.js";
import { getDb } from "../src/db.js";

await backupDatabase();
const db = await getDb();

async function foreignKeyExists(tableName, constraintName) {
  const [rows] = await db.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY' LIMIT 1`,
    [tableName, constraintName],
  );
  return Boolean(rows.length);
}

async function indexExists(tableName, indexName) {
  const [rows] = await db.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [tableName, indexName],
  );
  return Boolean(rows.length);
}

async function columnExists(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tableName, columnName],
  );
  return Boolean(rows.length);
}

try {
  await db.query("DELETE FROM finance_receipt_items");
  await db.query("DELETE FROM finance_receipts");
  await db.query("DELETE FROM saving_goal_entries WHERE transaction_id IS NOT NULL");
  await db.query("DELETE FROM transaction_drafts");
  await db.query("DELETE FROM transactions");

  if (await foreignKeyExists("saving_goal_entries", "fk_saving_goal_entries_transaction")) {
    await db.query(
      "ALTER TABLE saving_goal_entries DROP FOREIGN KEY fk_saving_goal_entries_transaction",
    );
  }
  if (await foreignKeyExists("finance_receipts", "fk_finance_receipts_transaction")) {
    await db.query(
      "ALTER TABLE finance_receipts DROP FOREIGN KEY fk_finance_receipts_transaction",
    );
  }
  if (await indexExists("transactions", "unique_transactions_uuid")) {
    await db.query("ALTER TABLE transactions DROP INDEX unique_transactions_uuid");
  }

  const [idColumns] = await db.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'id'`,
  );
  if (!String(idColumns[0]?.COLUMN_TYPE || "").startsWith("char(36)")) {
    await db.query("ALTER TABLE transactions MODIFY COLUMN id BIGINT UNSIGNED NOT NULL");
    await db.query("ALTER TABLE transactions DROP PRIMARY KEY");
    await db.query("ALTER TABLE transactions MODIFY COLUMN id CHAR(36) NOT NULL");
    await db.query("ALTER TABLE transactions ADD PRIMARY KEY (id)");
  }
  if (await columnExists("transactions", "uuid")) {
    await db.query("ALTER TABLE transactions DROP COLUMN uuid");
  }

  await db.query(
    "ALTER TABLE finance_receipts MODIFY COLUMN transaction_id CHAR(36) NULL",
  );
  await db.query(
    `ALTER TABLE saving_goal_entries
     ADD CONSTRAINT fk_saving_goal_entries_transaction
     FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL`,
  );
  await db.query(
    `ALTER TABLE finance_receipts
     ADD CONSTRAINT fk_finance_receipts_transaction
     FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL`,
  );
  console.log("Transaction data cleansed and transactions.id converted to UUID.");
} finally {
  await db.end();
}
