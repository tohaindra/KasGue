import { getDb } from "../src/db.js";

const requiredTables = [
  "users",
  "telegram_accounts",
  "finance_categories",
  "bank_wallet_account",
  "transactions",
  "saving_goals",
  "saving_goal_entries",
  "transaction_drafts",
  "finance_savings",
  "finance_sync_tokens",
  "finance_receipts",
  "finance_receipt_items",
];
const uuidForeignKeys = [
  ["finance_categories", "user_id"],
  ["telegram_accounts", "user_id"],
  ["telegram_accounts", "approved_by_user_id"],
  ["bank_wallet_account", "user_id"],
  ["transactions", "user_id"],
  ["transactions", "bank_wallet_account_id"],
  ["transactions", "category_id"],
  ["transactions", "saving_goal_id"],
  ["saving_goals", "user_id"],
  ["saving_goals", "bank_wallet_account_id"],
  ["saving_goal_entries", "saving_goal_id"],
  ["saving_goal_entries", "transaction_id"],
  ["transaction_drafts", "user_id"],
  ["transaction_drafts", "bank_wallet_account_id"],
  ["transaction_drafts", "category_id"],
  ["transaction_drafts", "saving_goal_id"],
  ["finance_savings", "user_id"],
  ["finance_sync_tokens", "user_id"],
  ["finance_receipts", "user_id"],
  ["finance_receipts", "transaction_id"],
  ["finance_receipt_items", "receipt_id"],
];
const expectedConstraints = [
  "fk_telegram_accounts_user",
  "fk_telegram_accounts_approved_by",
  "fk_finance_categories_user",
  "fk_bank_wallet_account_user",
  "fk_transactions_user",
  "fk_transactions_bank_wallet_account",
  "fk_transactions_category",
  "fk_transactions_saving_goal",
  "fk_saving_goals_user",
  "fk_saving_goals_account",
  "fk_saving_goal_entries_goal",
  "fk_saving_goal_entries_transaction",
  "fk_transaction_drafts_user",
  "fk_transaction_drafts_account",
  "fk_transaction_drafts_category",
  "fk_transaction_drafts_goal",
  "fk_finance_savings_user",
  "fk_finance_sync_tokens_user",
  "fk_finance_receipts_user",
  "fk_finance_receipts_transaction",
  "fk_finance_receipt_items_receipt",
];

const db = await getDb();
try {
  const [tables] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
    [[...requiredTables, "finance_users"]],
  );
  const existingTables = new Set(tables.map((row) => row.TABLE_NAME));
  const missingTables = requiredTables.filter((table) => !existingTables.has(table));

  const [columns] = await db.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND (TABLE_NAME IN (?) OR TABLE_NAME = 'finance_transactions')`,
    [requiredTables],
  );
  const columnMap = new Map(
    columns.map((row) => [`${row.TABLE_NAME}.${row.COLUMN_NAME}`, row]),
  );
  const hasLegacyFinanceTransactions = columns.some(
    (column) => column.TABLE_NAME === "finance_transactions",
  );
  const primaryKeyTables = [
    ...requiredTables,
    ...(hasLegacyFinanceTransactions ? ["finance_transactions"] : []),
  ];
  const invalidPrimaryKeys = primaryKeyTables
    .filter((table) => {
      const column = columnMap.get(`${table}.id`);
      return !column || String(column.COLUMN_TYPE).toLowerCase() !== "char(36)" || column.COLUMN_KEY !== "PRI";
    });
  const invalidForeignKeyColumns = uuidForeignKeys
    .map(([table, column]) => columnMap.get(`${table}.${column}`))
    .filter((column) => !column || String(column.COLUMN_TYPE).toLowerCase() !== "char(36)")
    .map((column) => column ? `${column.TABLE_NAME}.${column.COLUMN_NAME}` : "missing column");
  const obsoleteUuidColumns = ["users.uuid", "bank_wallet_account.uuid", "transactions.uuid"]
    .filter((key) => columnMap.has(key));
  const obsoleteFinanceUsersTable = existingTables.has("finance_users");

  const [constraints] = await db.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
  );
  const constraintNames = new Set(constraints.map((row) => row.CONSTRAINT_NAME));
  const missingConstraints = expectedConstraints.filter((name) => !constraintNames.has(name));

  if (
    missingTables.length ||
    invalidPrimaryKeys.length ||
    invalidForeignKeyColumns.length ||
    obsoleteUuidColumns.length ||
    missingConstraints.length ||
    obsoleteFinanceUsersTable
  ) {
    console.error("Finance UUID schema verification failed.");
    if (missingTables.length) console.error(`Missing tables: ${missingTables.join(", ")}`);
    if (invalidPrimaryKeys.length) console.error(`Invalid primary keys: ${invalidPrimaryKeys.join(", ")}`);
    if (invalidForeignKeyColumns.length) {
      console.error(`Invalid UUID foreign keys: ${invalidForeignKeyColumns.join(", ")}`);
    }
    if (obsoleteUuidColumns.length) {
      console.error(`Obsolete UUID columns: ${obsoleteUuidColumns.join(", ")}`);
    }
    if (missingConstraints.length) {
      console.error(`Missing foreign keys: ${missingConstraints.join(", ")}`);
    }
    if (obsoleteFinanceUsersTable) console.error("Obsolete table still exists: finance_users");
    process.exitCode = 1;
  } else {
    console.log("Finance UUID schema verification passed.");
  }
} finally {
  await db.end();
}
