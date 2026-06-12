import { backupDatabase } from "./backup-db.js";
import { getDb } from "../src/db.js";

await backupDatabase();
const db = await getDb();

async function tableExists(tableName) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tableName],
  );
  return Boolean(rows.length);
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

async function dropForeignKey(tableName, constraintName) {
  if (await foreignKeyExists(tableName, constraintName)) {
    await db.query(`ALTER TABLE ${tableName} DROP FOREIGN KEY ${constraintName}`);
  }
}

async function addForeignKey(tableName, constraintName, definition) {
  if (!(await foreignKeyExists(tableName, constraintName))) {
    await db.query(`ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${definition}`);
  }
}

try {
  if (!(await tableExists("finance_users"))) {
    console.log("User identity already standardized as users and telegram_accounts.");
  } else {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id CHAR(36) NOT NULL,
        full_name VARCHAR(255) NULL,
        email VARCHAR(255) NULL,
        phone VARCHAR(50) NULL,
        timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
        status ENUM('telegram_only', 'active', 'blocked') NOT NULL DEFAULT 'telegram_only',
        phone_verified_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS telegram_accounts (
        id CHAR(36) NOT NULL,
        user_id CHAR(36) NOT NULL,
        telegram_user_id BIGINT NOT NULL,
        telegram_chat_id BIGINT NULL,
        telegram_username VARCHAR(255) NULL,
        first_name VARCHAR(255) NULL,
        last_name VARCHAR(255) NULL,
        language_code VARCHAR(20) NULL,
        access_status VARCHAR(32) NOT NULL DEFAULT 'pending_profile',
        registration_step VARCHAR(32) NULL,
        approved_by_user_id CHAR(36) NULL,
        approved_at TIMESTAMP NULL,
        rejected_at TIMESTAMP NULL,
        last_seen_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY unique_telegram_accounts_user (user_id),
        UNIQUE KEY unique_telegram_accounts_telegram_user (telegram_user_id),
        INDEX idx_telegram_accounts_chat (telegram_chat_id)
      )
    `);

    await db.query(`
      INSERT INTO users
        (id, full_name, email, phone, timezone, status, created_at, updated_at)
      SELECT id, full_name, email, phone, timezone,
             CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'telegram_only' END,
             created_at, updated_at
      FROM finance_users
      ON DUPLICATE KEY UPDATE
        full_name = VALUES(full_name), email = VALUES(email), phone = VALUES(phone),
        timezone = VALUES(timezone), updated_at = VALUES(updated_at)
    `);
    await db.query(`
      INSERT INTO telegram_accounts
        (id, user_id, telegram_user_id, telegram_chat_id, telegram_username,
         first_name, last_name, language_code, access_status, registration_step,
         approved_by_user_id, approved_at, rejected_at, last_seen_at, created_at, updated_at)
      SELECT UUID(), id, telegram_user_id, telegram_chat_id, telegram_username,
             first_name, last_name, language_code, access_status, registration_step,
             approved_by_user_id, approved_at, rejected_at, last_seen_at, created_at, updated_at
      FROM finance_users
      ON DUPLICATE KEY UPDATE
        telegram_chat_id = VALUES(telegram_chat_id),
        telegram_username = VALUES(telegram_username),
        first_name = VALUES(first_name), last_name = VALUES(last_name),
        language_code = VALUES(language_code), access_status = VALUES(access_status),
        registration_step = VALUES(registration_step),
        approved_by_user_id = VALUES(approved_by_user_id),
        approved_at = VALUES(approved_at), rejected_at = VALUES(rejected_at),
        last_seen_at = VALUES(last_seen_at), updated_at = VALUES(updated_at)
    `);

    for (const [tableName, constraintName] of [
      ["finance_users", "fk_finance_users_approved_by"],
      ["finance_categories", "fk_finance_categories_user"],
      ["bank_wallet_account", "fk_bank_wallet_account_user"],
      ["saving_goals", "fk_saving_goals_user"],
      ["transactions", "fk_transactions_user"],
      ["transaction_drafts", "fk_transaction_drafts_user"],
      ["finance_savings", "fk_finance_savings_user"],
      ["finance_sync_tokens", "fk_finance_sync_tokens_user"],
      ["finance_receipts", "fk_finance_receipts_user"],
    ]) {
      await dropForeignKey(tableName, constraintName);
    }

    await addForeignKey(
      "telegram_accounts",
      "fk_telegram_accounts_user",
      "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
    );
    await addForeignKey(
      "telegram_accounts",
      "fk_telegram_accounts_approved_by",
      "FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
    );
    for (const [tableName, constraintName] of [
      ["finance_categories", "fk_finance_categories_user"],
      ["bank_wallet_account", "fk_bank_wallet_account_user"],
      ["transactions", "fk_transactions_user"],
      ["transaction_drafts", "fk_transaction_drafts_user"],
      ["finance_savings", "fk_finance_savings_user"],
      ["finance_sync_tokens", "fk_finance_sync_tokens_user"],
      ["finance_receipts", "fk_finance_receipts_user"],
    ]) {
      await addForeignKey(
        tableName,
        constraintName,
        "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
      );
    }
    await addForeignKey(
      "saving_goals",
      "fk_saving_goals_user",
      "FOREIGN KEY (user_id) REFERENCES users(id)",
    );

    await db.query("DROP TABLE finance_users");
    console.log("User identity migrated to users and telegram_accounts.");
  }
} finally {
  await db.end();
}
