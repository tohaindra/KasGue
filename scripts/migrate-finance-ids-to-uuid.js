import { backupDatabase } from "./backup-db.js";
import { getDb } from "../src/db.js";

await backupDatabase();
const pool = await getDb();
const db = await pool.getConnection();

async function tableExists(tableName) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tableName],
  );
  return Boolean(rows.length);
}

async function columnExists(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tableName, columnName],
  );
  return Boolean(rows.length);
}

async function columnType(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tableName, columnName],
  );
  return String(rows[0]?.COLUMN_TYPE || "").toLowerCase();
}

async function foreignKeyExists(tableName, constraintName) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY' LIMIT 1`,
    [tableName, constraintName],
  );
  return Boolean(rows.length);
}

async function indexExists(tableName, indexName) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [tableName, indexName],
  );
  return Boolean(rows.length);
}

async function dropForeignKey(tableName, constraintName) {
  if (await foreignKeyExists(tableName, constraintName)) {
    await db.query(`ALTER TABLE ${tableName} DROP FOREIGN KEY ${constraintName}`);
  }
}

async function convertPrimaryKeyFromMap(tableName, mapTable) {
  await db.query(`ALTER TABLE ${tableName} MODIFY COLUMN id BIGINT UNSIGNED NOT NULL`);
  await db.query(`ALTER TABLE ${tableName} DROP PRIMARY KEY`);
  await db.query(`ALTER TABLE ${tableName} MODIFY COLUMN id CHAR(36) NOT NULL`);
  await db.query(
    `UPDATE ${tableName} target
     JOIN ${mapTable} mapping ON mapping.old_id = CAST(target.id AS UNSIGNED)
     SET target.id = mapping.new_id`,
  );
  await db.query(`ALTER TABLE ${tableName} ADD PRIMARY KEY (id)`);
}

async function convertStandalonePrimaryKey(tableName) {
  if (!(await tableExists(tableName)) || (await columnType(tableName, "id")) === "char(36)") return;
  await db.query(`ALTER TABLE ${tableName} MODIFY COLUMN id BIGINT UNSIGNED NOT NULL`);
  await db.query(`ALTER TABLE ${tableName} DROP PRIMARY KEY`);
  await db.query(`ALTER TABLE ${tableName} MODIFY COLUMN id CHAR(36) NOT NULL`);
  await db.query(`UPDATE ${tableName} SET id = UUID()`);
  await db.query(`ALTER TABLE ${tableName} ADD PRIMARY KEY (id)`);
}

try {
  if (
    (await columnType("finance_users", "id")) === "char(36)" &&
    !(await columnExists("finance_users", "uuid"))
  ) {
    console.log("Finance primary keys already use UUID.");
    process.exitCode = 0;
  } else {
    await db.query("SET FOREIGN_KEY_CHECKS = 0");

    await db.query(`CREATE TEMPORARY TABLE map_finance_users (
      old_id BIGINT UNSIGNED PRIMARY KEY, new_id CHAR(36) NOT NULL UNIQUE
    )`);
    await db.query(
      "INSERT INTO map_finance_users (old_id, new_id) SELECT id, COALESCE(uuid, UUID()) FROM finance_users",
    );
    await db.query(`CREATE TEMPORARY TABLE map_finance_accounts (
      old_id BIGINT UNSIGNED PRIMARY KEY, new_id CHAR(36) NOT NULL UNIQUE
    )`);
    await db.query(
      "INSERT INTO map_finance_accounts (old_id, new_id) SELECT id, COALESCE(uuid, UUID()) FROM finance_accounts",
    );
    await db.query(`CREATE TEMPORARY TABLE map_finance_categories (
      old_id BIGINT UNSIGNED PRIMARY KEY, new_id CHAR(36) NOT NULL UNIQUE
    )`);
    await db.query(
      "INSERT INTO map_finance_categories (old_id, new_id) SELECT id, UUID() FROM finance_categories",
    );
    await db.query(`CREATE TEMPORARY TABLE map_finance_receipts (
      old_id BIGINT UNSIGNED PRIMARY KEY, new_id CHAR(36) NOT NULL UNIQUE
    )`);
    await db.query(
      "INSERT INTO map_finance_receipts (old_id, new_id) SELECT id, UUID() FROM finance_receipts",
    );

    for (const [tableName, constraintName] of [
      ["finance_categories", "fk_finance_categories_user"],
      ["finance_users", "fk_finance_users_approved_by"],
      ["finance_accounts", "fk_finance_accounts_user"],
      ["transactions", "fk_transactions_user"],
      ["transactions", "fk_transactions_account"],
      ["transactions", "fk_transactions_category"],
      ["saving_goals", "fk_saving_goals_user"],
      ["saving_goals", "fk_saving_goals_account"],
      ["transaction_drafts", "fk_transaction_drafts_user"],
      ["transaction_drafts", "fk_transaction_drafts_account"],
      ["transaction_drafts", "fk_transaction_drafts_category"],
      ["finance_savings", "fk_finance_savings_user"],
      ["finance_sync_tokens", "fk_finance_sync_tokens_user"],
      ["finance_receipts", "fk_finance_receipts_user"],
      ["finance_receipt_items", "fk_finance_receipt_items_receipt"],
    ]) {
      await dropForeignKey(tableName, constraintName);
    }

    const userReferences = [
      ["finance_categories", "user_id"],
      ["finance_accounts", "user_id"],
      ["transactions", "user_id"],
      ["finance_savings", "user_id"],
      ["finance_sync_tokens", "user_id"],
      ["finance_receipts", "user_id"],
    ];
    for (const [tableName, columnName] of userReferences) {
      await db.query(`ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} CHAR(36) ${tableName === "finance_categories" ? "NULL" : "NOT NULL"}`);
      await db.query(
        `UPDATE ${tableName} target
         JOIN map_finance_users mapping ON mapping.old_id = CAST(target.${columnName} AS UNSIGNED)
         SET target.${columnName} = mapping.new_id`,
      );
    }

    await db.query("ALTER TABLE finance_users MODIFY COLUMN approved_by_user_id CHAR(36) NULL");
    await db.query(
      `UPDATE finance_users target
       LEFT JOIN map_finance_users mapping ON mapping.old_id = CAST(target.approved_by_user_id AS UNSIGNED)
       SET target.approved_by_user_id = mapping.new_id
       WHERE target.approved_by_user_id IS NOT NULL`,
    );

    await db.query("ALTER TABLE transactions MODIFY COLUMN account_id CHAR(36) NULL");
    await db.query(
      `UPDATE transactions target
       LEFT JOIN map_finance_accounts mapping ON mapping.old_id = CAST(target.account_id AS UNSIGNED)
       SET target.account_id = mapping.new_id WHERE target.account_id IS NOT NULL`,
    );
    await db.query("ALTER TABLE transactions MODIFY COLUMN category_id CHAR(36) NULL");
    await db.query(
      `UPDATE transactions target
       LEFT JOIN map_finance_categories mapping ON mapping.old_id = CAST(target.category_id AS UNSIGNED)
       SET target.category_id = mapping.new_id WHERE target.category_id IS NOT NULL`,
    );
    await db.query("ALTER TABLE transaction_drafts MODIFY COLUMN category_id CHAR(36) NULL");
    await db.query(
      `UPDATE transaction_drafts target
       LEFT JOIN map_finance_categories mapping ON mapping.old_id = CAST(target.category_id AS UNSIGNED)
       SET target.category_id = mapping.new_id WHERE target.category_id IS NOT NULL`,
    );
    await db.query("ALTER TABLE finance_receipt_items MODIFY COLUMN receipt_id CHAR(36) NOT NULL");
    await db.query(
      `UPDATE finance_receipt_items target
       JOIN map_finance_receipts mapping ON mapping.old_id = CAST(target.receipt_id AS UNSIGNED)
       SET target.receipt_id = mapping.new_id`,
    );

    await convertPrimaryKeyFromMap("finance_users", "map_finance_users");
    await convertPrimaryKeyFromMap("finance_accounts", "map_finance_accounts");
    await convertPrimaryKeyFromMap("finance_categories", "map_finance_categories");
    await convertPrimaryKeyFromMap("finance_receipts", "map_finance_receipts");

    if (await indexExists("finance_users", "unique_finance_users_uuid")) {
      await db.query("ALTER TABLE finance_users DROP INDEX unique_finance_users_uuid");
    }
    if (await indexExists("finance_accounts", "unique_finance_accounts_uuid")) {
      await db.query("ALTER TABLE finance_accounts DROP INDEX unique_finance_accounts_uuid");
    }
    if (await columnExists("finance_users", "uuid")) {
      await db.query("ALTER TABLE finance_users DROP COLUMN uuid");
    }
    if (await columnExists("finance_accounts", "uuid")) {
      await db.query("ALTER TABLE finance_accounts DROP COLUMN uuid");
    }

    await convertStandalonePrimaryKey("finance_savings");
    await convertStandalonePrimaryKey("finance_sync_tokens");
    await convertStandalonePrimaryKey("finance_receipt_items");
    await convertStandalonePrimaryKey("finance_transactions");

    for (const statement of [
      "ALTER TABLE finance_users ADD CONSTRAINT fk_finance_users_approved_by FOREIGN KEY (approved_by_user_id) REFERENCES finance_users(id) ON DELETE SET NULL",
      "ALTER TABLE finance_categories ADD CONSTRAINT fk_finance_categories_user FOREIGN KEY (user_id) REFERENCES finance_users(id) ON DELETE CASCADE",
      "ALTER TABLE finance_accounts ADD CONSTRAINT fk_finance_accounts_user FOREIGN KEY (user_id) REFERENCES finance_users(id) ON DELETE CASCADE",
      "ALTER TABLE transactions ADD CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES finance_users(id) ON DELETE CASCADE",
      "ALTER TABLE transactions ADD CONSTRAINT fk_transactions_account FOREIGN KEY (account_id) REFERENCES finance_accounts(id) ON DELETE SET NULL",
      "ALTER TABLE transactions ADD CONSTRAINT fk_transactions_category FOREIGN KEY (category_id) REFERENCES finance_categories(id) ON DELETE SET NULL",
      "ALTER TABLE saving_goals ADD CONSTRAINT fk_saving_goals_user FOREIGN KEY (user_id) REFERENCES finance_users(id)",
      "ALTER TABLE saving_goals ADD CONSTRAINT fk_saving_goals_account FOREIGN KEY (bank_wallet_account_id) REFERENCES finance_accounts(id)",
      "ALTER TABLE transaction_drafts ADD CONSTRAINT fk_transaction_drafts_user FOREIGN KEY (user_id) REFERENCES finance_users(id) ON DELETE CASCADE",
      "ALTER TABLE transaction_drafts ADD CONSTRAINT fk_transaction_drafts_account FOREIGN KEY (bank_wallet_account_id) REFERENCES finance_accounts(id) ON DELETE SET NULL",
      "ALTER TABLE transaction_drafts ADD CONSTRAINT fk_transaction_drafts_category FOREIGN KEY (category_id) REFERENCES finance_categories(id) ON DELETE SET NULL",
      "ALTER TABLE finance_savings ADD CONSTRAINT fk_finance_savings_user FOREIGN KEY (user_id) REFERENCES finance_users(id) ON DELETE CASCADE",
      "ALTER TABLE finance_sync_tokens ADD CONSTRAINT fk_finance_sync_tokens_user FOREIGN KEY (user_id) REFERENCES finance_users(id) ON DELETE CASCADE",
      "ALTER TABLE finance_receipts ADD CONSTRAINT fk_finance_receipts_user FOREIGN KEY (user_id) REFERENCES finance_users(id) ON DELETE CASCADE",
      "ALTER TABLE finance_receipt_items ADD CONSTRAINT fk_finance_receipt_items_receipt FOREIGN KEY (receipt_id) REFERENCES finance_receipts(id) ON DELETE CASCADE",
    ]) {
      await db.query(statement);
    }

    await db.query("SET FOREIGN_KEY_CHECKS = 1");
    console.log("All finance primary and foreign keys converted to UUID CHAR(36).");
  }
} finally {
  try {
    await db.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    db.release();
    await pool.end();
  }
}
