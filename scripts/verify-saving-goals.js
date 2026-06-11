import { getDb } from "../src/db.js";

const expectedTables = ["transactions", "saving_goals", "saving_goal_entries", "transaction_drafts"];
const db = await getDb();

try {
  const [tables] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
    [expectedTables],
  );
  const existing = new Set(tables.map((row) => row.TABLE_NAME));
  const missingTables = expectedTables.filter((table) => !existing.has(table));

  const [columns] = await db.query(
    `SELECT TABLE_NAME, COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND ((TABLE_NAME = 'transactions' AND COLUMN_NAME IN ('uuid', 'saving_goal_id'))
         OR (TABLE_NAME = 'transaction_drafts' AND COLUMN_NAME IN (
           'user_id', 'bank_wallet_account_id', 'category_id', 'transaction_type',
           'amount', 'currency', 'description', 'occurred_at', 'source',
           'source_reference', 'context', 'saving_goal_id'
         ))
         OR (TABLE_NAME = 'finance_users' AND COLUMN_NAME = 'uuid')
         OR (TABLE_NAME = 'finance_accounts' AND COLUMN_NAME = 'uuid'))`,
  );
  const columnKeys = new Set(columns.map((row) => `${row.TABLE_NAME}.${row.COLUMN_NAME}`));
  const expectedColumns = [
    "transactions.uuid",
    "transactions.saving_goal_id",
    "finance_users.uuid",
    "finance_accounts.uuid",
    "transaction_drafts.user_id",
    "transaction_drafts.bank_wallet_account_id",
    "transaction_drafts.category_id",
    "transaction_drafts.transaction_type",
    "transaction_drafts.amount",
    "transaction_drafts.currency",
    "transaction_drafts.description",
    "transaction_drafts.occurred_at",
    "transaction_drafts.source",
    "transaction_drafts.source_reference",
    "transaction_drafts.context",
    "transaction_drafts.saving_goal_id",
  ];
  const missingColumns = expectedColumns.filter((column) => !columnKeys.has(column));
  const nullableUuidColumns = columns
    .filter((row) => row.COLUMN_NAME === "uuid" && row.IS_NULLABLE === "YES")
    .map((row) => `${row.TABLE_NAME}.${row.COLUMN_NAME}`);

  const [constraints] = await db.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'
       AND CONSTRAINT_NAME IN (
         'fk_saving_goals_user', 'fk_saving_goals_account',
         'fk_transactions_saving_goal', 'fk_saving_goal_entries_goal',
         'fk_saving_goal_entries_transaction', 'fk_transaction_drafts_user',
         'fk_transaction_drafts_goal', 'fk_transaction_drafts_account',
         'fk_transaction_drafts_category'
       )`,
  );
  const expectedConstraints = [
    "fk_saving_goals_user",
    "fk_saving_goals_account",
    "fk_transactions_saving_goal",
    "fk_saving_goal_entries_goal",
    "fk_saving_goal_entries_transaction",
    "fk_transaction_drafts_user",
    "fk_transaction_drafts_goal",
    "fk_transaction_drafts_account",
    "fk_transaction_drafts_category",
  ];
  const constraintNames = new Set(constraints.map((row) => row.CONSTRAINT_NAME));
  const missingConstraints = expectedConstraints.filter((name) => !constraintNames.has(name));

  if (
    missingTables.length ||
    missingColumns.length ||
    nullableUuidColumns.length ||
    missingConstraints.length
  ) {
    console.error("Saving Goal schema verification failed.");
    if (missingTables.length) console.error(`Missing tables: ${missingTables.join(", ")}`);
    if (missingColumns.length) console.error(`Missing columns: ${missingColumns.join(", ")}`);
    if (nullableUuidColumns.length) {
      console.error(`Nullable UUID columns: ${nullableUuidColumns.join(", ")}`);
    }
    if (missingConstraints.length) console.error(`Missing foreign keys: ${missingConstraints.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("Saving Goal schema verification passed.");
  }
} finally {
  await db.end();
}
