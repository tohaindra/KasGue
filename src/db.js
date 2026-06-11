import mysql from "mysql2/promise";
import { getConfig } from "./config.js";

export async function getDb() {
  return mysql.createPool({
    ...getConfig().mysql,
    waitForConnections: true,
    connectionLimit: 5,
    namedPlaceholders: true,
  });
}

async function ensureColumns(db, tableName, columns) {
  for (const [column, definition] of columns) {
    const [existing] = await db.query(
      `
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
        LIMIT 1
      `,
      [tableName, column],
    );
    if (!existing.length) {
      await db.query(`ALTER TABLE ${tableName} ADD COLUMN ${column} ${definition}`);
    }
  }
}

async function ensureIndex(db, tableName, indexName, definition) {
  const [existing] = await db.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [tableName, indexName],
  );
  if (!existing.length) await db.query(`ALTER TABLE ${tableName} ADD ${definition}`);
}

async function dropForeignKeyIfExists(db, tableName, constraintName) {
  const [rows] = await db.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY' LIMIT 1`,
    [tableName, constraintName],
  );
  if (rows.length) await db.query(`ALTER TABLE ${tableName} DROP FOREIGN KEY ${constraintName}`);
}

async function renameIndexIfExists(db, tableName, oldName, newName) {
  const [oldRows] = await db.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [tableName, oldName],
  );
  const [newRows] = await db.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [tableName, newName],
  );
  if (oldRows.length && !newRows.length) {
    await db.query(`ALTER TABLE ${tableName} RENAME INDEX ${oldName} TO ${newName}`);
  }
}

async function ensureForeignKey(db, tableName, constraintName, definition) {
  const [existing] = await db.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY' LIMIT 1`,
    [tableName, constraintName],
  );
  if (!existing.length) {
    await db.query(`ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${definition}`);
  }
}

async function tableExists(db, tableName) {
  const [rows] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [tableName],
  );
  return Boolean(rows.length);
}

async function columnExists(db, tableName, columnName) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tableName, columnName],
  );
  return Boolean(rows.length);
}

async function standardizeTransactionTableNames(db) {
  if ((await tableExists(db, "finance_entries")) && !(await tableExists(db, "transactions"))) {
    await db.query("RENAME TABLE finance_entries TO transactions");
  }
  if (
    (await tableExists(db, "telegram_transaction_drafts")) &&
    !(await tableExists(db, "transaction_drafts"))
  ) {
    await db.query("RENAME TABLE telegram_transaction_drafts TO transaction_drafts");
  }
  if (
    (await tableExists(db, "finance_receipts")) &&
    (await columnExists(db, "finance_receipts", "entry_id")) &&
    !(await columnExists(db, "finance_receipts", "transaction_id"))
  ) {
    await db.query("ALTER TABLE finance_receipts RENAME COLUMN entry_id TO transaction_id");
  }
}

async function ensureFinanceEntrySourceEnum(db) {
  const [rows] = await db.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
       AND COLUMN_NAME = 'source' LIMIT 1`,
  );
  if (!String(rows[0]?.COLUMN_TYPE || "").includes("telegram_bot")) {
    await db.query(
      "ALTER TABLE transactions MODIFY COLUMN source ENUM('telegram', 'telegram_bot', 'mobile', 'web', 'import') NOT NULL DEFAULT 'telegram'",
    );
  }
}

async function ensureNotNullUuid(db, tableName) {
  const [rows] = await db.query(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'uuid' LIMIT 1`,
    [tableName],
  );
  if (rows[0]?.IS_NULLABLE === "YES") {
    await db.query(`ALTER TABLE ${tableName} MODIFY COLUMN uuid CHAR(36) NOT NULL`);
  }
}

export async function ensureSchema(db) {
  await standardizeTransactionTableNames(db);
  await db.query(`
    CREATE TABLE IF NOT EXISTS processed_emails (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      message_id VARCHAR(512) NOT NULL,
      uid VARCHAR(128) NULL,
      sender TEXT NULL,
      subject TEXT NULL,
      email_date VARCHAR(255) NULL,
      score INT NOT NULL DEFAULT 0,
      should_forward BOOLEAN NOT NULL DEFAULT FALSE,
      forwarded BOOLEAN NOT NULL DEFAULT FALSE,
      source VARCHAR(64) NOT NULL DEFAULT 'rules',
      reasons JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_message_id (message_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS scan_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      status VARCHAR(32) NOT NULL,
      scanned_count INT NOT NULL DEFAULT 0,
      forwarded_count INT NOT NULL DEFAULT 0,
      error_text TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS finance_users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      telegram_user_id BIGINT NOT NULL,
      telegram_chat_id BIGINT NULL,
      telegram_username VARCHAR(255) NULL,
      first_name VARCHAR(255) NULL,
      last_name VARCHAR(255) NULL,
      full_name VARCHAR(255) NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(50) NULL,
      access_status VARCHAR(32) NOT NULL DEFAULT 'pending_profile',
      registration_step VARCHAR(32) NULL,
      approved_by_user_id BIGINT UNSIGNED NULL,
      approved_at TIMESTAMP NULL,
      rejected_at TIMESTAMP NULL,
      language_code VARCHAR(20) NULL,
      timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
      status ENUM('active', 'blocked') NOT NULL DEFAULT 'active',
      last_seen_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_finance_telegram_user (telegram_user_id),
      INDEX idx_finance_users_chat (telegram_chat_id)
    )
  `);
  await ensureColumns(db, "finance_users", [
    ["uuid", "CHAR(36) NULL"],
    ["full_name", "VARCHAR(255) NULL"],
    ["email", "VARCHAR(255) NULL"],
    ["phone", "VARCHAR(50) NULL"],
    ["access_status", "VARCHAR(32) NOT NULL DEFAULT 'pending_profile'"],
    ["registration_step", "VARCHAR(32) NULL"],
    ["approved_by_user_id", "BIGINT UNSIGNED NULL"],
    ["approved_at", "TIMESTAMP NULL"],
    ["rejected_at", "TIMESTAMP NULL"],
  ]);
  await db.query("UPDATE finance_users SET uuid = UUID() WHERE uuid IS NULL");
  await ensureNotNullUuid(db, "finance_users");
  await ensureIndex(db, "finance_users", "unique_finance_users_uuid", "UNIQUE KEY unique_finance_users_uuid (uuid)");
  await db.query(`
    CREATE TABLE IF NOT EXISTS finance_categories (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NULL,
      transaction_type ENUM('expense', 'income') NOT NULL,
      slug VARCHAR(120) NOT NULL,
      name VARCHAR(255) NOT NULL,
      color VARCHAR(20) NULL,
      icon VARCHAR(40) NULL,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_finance_category (user_id, transaction_type, slug)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS finance_accounts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(255) NOT NULL,
      account_type ENUM('cash', 'bank', 'ewallet', 'credit_card', 'other') NOT NULL DEFAULT 'cash',
      currency CHAR(3) NOT NULL DEFAULT 'IDR',
      opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      archived_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_finance_account_name (user_id, name),
      INDEX idx_finance_accounts_user (user_id)
    )
  `);
  await ensureColumns(db, "finance_accounts", [["uuid", "CHAR(36) NULL"]]);
  await db.query("UPDATE finance_accounts SET uuid = UUID() WHERE uuid IS NULL");
  await ensureNotNullUuid(db, "finance_accounts");
  await ensureIndex(db, "finance_accounts", "unique_finance_accounts_uuid", "UNIQUE KEY unique_finance_accounts_uuid (uuid)");
  await db.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      account_id BIGINT UNSIGNED NULL,
      category_id BIGINT UNSIGNED NULL,
      transaction_type ENUM('expense', 'income', 'transfer') NOT NULL,
      amount DECIMAL(15,2) NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'IDR',
      description TEXT NULL,
      raw_text TEXT NULL,
      source ENUM('telegram', 'mobile', 'web', 'import') NOT NULL DEFAULT 'telegram',
      source_message_id BIGINT NULL,
      source_chat_id BIGINT NULL,
      occurred_at DATETIME NOT NULL,
      sync_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
      deleted_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_transactions_user_occurred (user_id, occurred_at),
      INDEX idx_transactions_user_sync (user_id, sync_version, updated_at),
      INDEX idx_transactions_source (source, source_message_id),
      UNIQUE KEY unique_finance_entry_source (user_id, source, source_message_id)
    )
  `);
  await ensureColumns(db, "transactions", [
    ["uuid", "CHAR(36) NULL"],
    ["saving_goal_id", "CHAR(36) NULL"],
  ]);
  await db.query("UPDATE transactions SET uuid = UUID() WHERE uuid IS NULL");
  await ensureNotNullUuid(db, "transactions");
  await ensureFinanceEntrySourceEnum(db);
  await renameIndexIfExists(db, "transactions", "unique_finance_entries_uuid", "unique_transactions_uuid");
  await renameIndexIfExists(db, "transactions", "idx_finance_entries_user_occurred", "idx_transactions_user_occurred");
  await renameIndexIfExists(db, "transactions", "idx_finance_entries_user_sync", "idx_transactions_user_sync");
  await renameIndexIfExists(db, "transactions", "idx_finance_entries_source", "idx_transactions_source");
  await renameIndexIfExists(db, "transactions", "idx_finance_entries_saving_goal", "idx_transactions_saving_goal");
  await ensureIndex(db, "transactions", "unique_transactions_uuid", "UNIQUE KEY unique_transactions_uuid (uuid)");
  await ensureIndex(db, "transactions", "idx_transactions_saving_goal", "INDEX idx_transactions_saving_goal (saving_goal_id)");
  for (const legacyConstraint of [
    "fk_finance_entries_user",
    "fk_finance_entries_account",
    "fk_finance_entries_category",
  ]) {
    await dropForeignKeyIfExists(db, "transactions", legacyConstraint);
  }
  await ensureForeignKey(
    db,
    "transactions",
    "fk_transactions_user",
    "FOREIGN KEY (user_id) REFERENCES finance_users(id) ON DELETE CASCADE",
  );
  await ensureForeignKey(
    db,
    "transactions",
    "fk_transactions_account",
    "FOREIGN KEY (account_id) REFERENCES finance_accounts(id) ON DELETE SET NULL",
  );
  await ensureForeignKey(
    db,
    "transactions",
    "fk_transactions_category",
    "FOREIGN KEY (category_id) REFERENCES finance_categories(id) ON DELETE SET NULL",
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS saving_goals (
      id CHAR(36) NOT NULL,
      user_id CHAR(36) NOT NULL,
      bank_wallet_account_id CHAR(36) NOT NULL,
      name VARCHAR(150) NOT NULL,
      target_amount DECIMAL(18,2) NULL,
      initial_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
      target_date DATE NULL,
      note TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      color VARCHAR(20) NULL,
      icon VARCHAR(50) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_saving_goals_user_status (user_id, status),
      INDEX idx_saving_goals_user_name (user_id, name),
      INDEX idx_saving_goals_account (bank_wallet_account_id),
      CONSTRAINT fk_saving_goals_user FOREIGN KEY (user_id) REFERENCES finance_users(uuid),
      CONSTRAINT fk_saving_goals_account FOREIGN KEY (bank_wallet_account_id) REFERENCES finance_accounts(uuid)
    )
  `);
  await ensureForeignKey(
    db,
    "transactions",
    "fk_transactions_saving_goal",
    "FOREIGN KEY (saving_goal_id) REFERENCES saving_goals(id) ON DELETE SET NULL",
  );
  await dropForeignKeyIfExists(db, "transactions", "fk_finance_entries_saving_goal");
  await db.query(`
    CREATE TABLE IF NOT EXISTS saving_goal_entries (
      id CHAR(36) NOT NULL,
      saving_goal_id CHAR(36) NOT NULL,
      transaction_id CHAR(36) NULL,
      entry_type VARCHAR(40) NOT NULL,
      amount DECIMAL(18,2) NOT NULL,
      entry_date DATE NOT NULL,
      note TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_saving_goal_entries_goal_date (saving_goal_id, entry_date),
      INDEX idx_saving_goal_entries_transaction (transaction_id),
      CONSTRAINT fk_saving_goal_entries_goal FOREIGN KEY (saving_goal_id) REFERENCES saving_goals(id) ON DELETE CASCADE,
      CONSTRAINT fk_saving_goal_entries_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(uuid) ON DELETE SET NULL
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS transaction_drafts (
      id CHAR(36) NOT NULL,
      user_id CHAR(36) NOT NULL,
      bank_wallet_account_id CHAR(36) NULL,
      category_id BIGINT UNSIGNED NULL,
      transaction_type ENUM('expense', 'income', 'transfer') NOT NULL,
      amount DECIMAL(18,2) NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'IDR',
      description TEXT NULL,
      occurred_at DATETIME NULL,
      source VARCHAR(30) NOT NULL,
      source_reference VARCHAR(255) NULL,
      context JSON NULL,
      draft_type VARCHAR(40) NOT NULL,
      payload JSON NOT NULL,
      saving_goal_id CHAR(36) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_transaction_drafts_user_status (user_id, status, expires_at),
      INDEX idx_transaction_drafts_source (source, source_reference),
      CONSTRAINT fk_transaction_drafts_user FOREIGN KEY (user_id) REFERENCES finance_users(uuid) ON DELETE CASCADE,
      CONSTRAINT fk_transaction_drafts_account FOREIGN KEY (bank_wallet_account_id) REFERENCES finance_accounts(uuid) ON DELETE SET NULL,
      CONSTRAINT fk_transaction_drafts_category FOREIGN KEY (category_id) REFERENCES finance_categories(id) ON DELETE SET NULL,
      CONSTRAINT fk_transaction_drafts_goal FOREIGN KEY (saving_goal_id) REFERENCES saving_goals(id) ON DELETE SET NULL
    )
  `);
  await ensureColumns(db, "transaction_drafts", [
    ["source", "VARCHAR(30) NULL"],
    ["source_reference", "VARCHAR(255) NULL"],
    ["context", "JSON NULL"],
    ["saving_goal_id", "CHAR(36) NULL"],
    ["bank_wallet_account_id", "CHAR(36) NULL"],
    ["category_id", "BIGINT UNSIGNED NULL"],
    ["transaction_type", "ENUM('expense', 'income', 'transfer') NULL"],
    ["amount", "DECIMAL(18,2) NULL"],
    ["currency", "CHAR(3) NOT NULL DEFAULT 'IDR'"],
    ["description", "TEXT NULL"],
    ["occurred_at", "DATETIME NULL"],
  ]);
  if (await columnExists(db, "transaction_drafts", "selected_saving_goal_id")) {
    await db.query(
      "UPDATE transaction_drafts SET saving_goal_id = selected_saving_goal_id WHERE saving_goal_id IS NULL",
    );
  }
  if (await columnExists(db, "transaction_drafts", "chat_id")) {
    await db.query(
      `UPDATE transaction_drafts
       SET source = COALESCE(source, 'telegram_bot'),
           source_reference = COALESCE(source_reference, CONCAT('telegram:', chat_id, ':', COALESCE(source_message_id, ''))),
           context = COALESCE(context, JSON_OBJECT('chat_id', chat_id, 'message_id', source_message_id))`,
    );
  }
  await db.query("UPDATE transaction_drafts SET source = 'telegram_bot' WHERE source IS NULL");
  await db.query(
    `UPDATE transaction_drafts
     SET transaction_type = COALESCE(transaction_type, 'expense'),
         amount = COALESCE(amount, JSON_UNQUOTE(JSON_EXTRACT(payload, '$.amount')), 0),
         description = COALESCE(description, JSON_UNQUOTE(JSON_EXTRACT(payload, '$.note')))` ,
  );
  await db.query("ALTER TABLE transaction_drafts MODIFY COLUMN source VARCHAR(30) NOT NULL");
  await db.query(
    "ALTER TABLE transaction_drafts MODIFY COLUMN transaction_type ENUM('expense', 'income', 'transfer') NOT NULL, MODIFY COLUMN amount DECIMAL(18,2) NOT NULL",
  );
  await dropForeignKeyIfExists(db, "transaction_drafts", "fk_telegram_drafts_goal");
  await dropForeignKeyIfExists(db, "transaction_drafts", "fk_telegram_drafts_user");
  for (const legacyColumn of ["selected_saving_goal_id", "chat_id", "source_message_id"]) {
    if (await columnExists(db, "transaction_drafts", legacyColumn)) {
      await db.query(`ALTER TABLE transaction_drafts DROP COLUMN ${legacyColumn}`);
    }
  }
  await ensureIndex(
    db,
    "transaction_drafts",
    "idx_transaction_drafts_source",
    "INDEX idx_transaction_drafts_source (source, source_reference)",
  );
  await ensureIndex(
    db,
    "transaction_drafts",
    "idx_transaction_drafts_user_status",
    "INDEX idx_transaction_drafts_user_status (user_id, status, expires_at)",
  );
  await ensureForeignKey(
    db,
    "transaction_drafts",
    "fk_transaction_drafts_user",
    "FOREIGN KEY (user_id) REFERENCES finance_users(uuid) ON DELETE CASCADE",
  );
  await ensureForeignKey(
    db,
    "transaction_drafts",
    "fk_transaction_drafts_account",
    "FOREIGN KEY (bank_wallet_account_id) REFERENCES finance_accounts(uuid) ON DELETE SET NULL",
  );
  await ensureForeignKey(
    db,
    "transaction_drafts",
    "fk_transaction_drafts_category",
    "FOREIGN KEY (category_id) REFERENCES finance_categories(id) ON DELETE SET NULL",
  );
  await ensureForeignKey(
    db,
    "transaction_drafts",
    "fk_transaction_drafts_goal",
    "FOREIGN KEY (saving_goal_id) REFERENCES saving_goals(id) ON DELETE SET NULL",
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS finance_savings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      account_name VARCHAR(255) NOT NULL,
      amount DECIMAL(15,2) NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'IDR',
      description TEXT NULL,
      raw_text TEXT NULL,
      source ENUM('telegram', 'mobile', 'web', 'import') NOT NULL DEFAULT 'telegram',
      source_message_id BIGINT NULL,
      source_chat_id BIGINT NULL,
      observed_at DATETIME NOT NULL,
      sync_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
      deleted_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_finance_savings_user_observed (user_id, observed_at),
      INDEX idx_finance_savings_user_sync (user_id, sync_version, updated_at),
      UNIQUE KEY unique_finance_saving_source (user_id, source, source_message_id)
    )
  `);
  await db.query(`
    INSERT INTO finance_accounts
      (uuid, user_id, name, account_type, currency, opening_balance, is_default)
    SELECT UUID(), latest.user_id, latest.account_name, 'bank', latest.currency, latest.amount, FALSE
    FROM finance_savings latest
    INNER JOIN (
      SELECT user_id, account_name, MAX(observed_at) AS max_observed_at
      FROM finance_savings
      WHERE deleted_at IS NULL
      GROUP BY user_id, account_name
    ) newest
      ON newest.user_id = latest.user_id
     AND newest.account_name = latest.account_name
     AND newest.max_observed_at = latest.observed_at
    LEFT JOIN finance_accounts account
      ON account.user_id = latest.user_id AND LOWER(account.name) = LOWER(latest.account_name)
    WHERE latest.deleted_at IS NULL AND account.id IS NULL
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS finance_sync_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      token_name VARCHAR(255) NOT NULL DEFAULT 'mobile',
      last_used_at TIMESTAMP NULL,
      expires_at TIMESTAMP NULL,
      revoked_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_finance_sync_token (token_hash),
      INDEX idx_finance_sync_tokens_user (user_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS finance_receipts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      transaction_id BIGINT UNSIGNED NULL,
      merchant_name VARCHAR(255) NULL,
      merchant_branch VARCHAR(255) NULL,
      receipt_number VARCHAR(255) NULL,
      document_type VARCHAR(50) NULL,
      bank_name VARCHAR(255) NULL,
      sender_name VARCHAR(255) NULL,
      receiver_name VARCHAR(255) NULL,
      transaction_at DATETIME NULL,
      subtotal DECIMAL(15,2) NULL,
      discount_total DECIMAL(15,2) NULL,
      tax_total DECIMAL(15,2) NULL,
      total_amount DECIMAL(15,2) NOT NULL,
      payment_method VARCHAR(100) NULL,
      source_chat_id BIGINT NULL,
      source_message_id BIGINT NULL,
      telegram_file_id VARCHAR(255) NULL,
      ocr_model VARCHAR(100) NULL,
      ocr_raw JSON NULL,
      status ENUM('parsed', 'needs_review', 'failed') NOT NULL DEFAULT 'parsed',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_finance_receipts_user_date (user_id, transaction_at),
      INDEX idx_finance_receipts_source (source_chat_id, source_message_id)
    )
  `);
  await ensureColumns(db, "finance_receipts", [
    ["document_type", "VARCHAR(50) NULL"],
    ["bank_name", "VARCHAR(255) NULL"],
    ["sender_name", "VARCHAR(255) NULL"],
    ["receiver_name", "VARCHAR(255) NULL"],
  ]);
  await db.query(`
    CREATE TABLE IF NOT EXISTS finance_receipt_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      receipt_id BIGINT UNSIGNED NOT NULL,
      item_name VARCHAR(255) NOT NULL,
      quantity DECIMAL(10,2) NULL,
      unit_price DECIMAL(15,2) NULL,
      line_total DECIMAL(15,2) NULL,
      category_name VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_finance_receipt_items_receipt (receipt_id)
    )
  `);
}
