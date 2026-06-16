CREATE DATABASE IF NOT EXISTS email_forwarder
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE email_forwarder;

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
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  status VARCHAR(32) NOT NULL,
  scanned_count INT NOT NULL DEFAULT 0,
  forwarded_count INT NOT NULL DEFAULT 0,
  error_text TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

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
);

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
  INDEX idx_telegram_accounts_chat (telegram_chat_id),
  CONSTRAINT fk_telegram_accounts_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_telegram_accounts_approved_by
    FOREIGN KEY (approved_by_user_id) REFERENCES users(id)
    ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS finance_categories (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  transaction_type ENUM('expense', 'income') NOT NULL,
  slug VARCHAR(120) NOT NULL,
  name VARCHAR(255) NOT NULL,
  color VARCHAR(20) NULL,
  icon VARCHAR(40) NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY unique_finance_category (user_id, transaction_type, slug),
  CONSTRAINT fk_finance_categories_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bank_wallet_account (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  institution_name VARCHAR(255) NULL,
  account_type ENUM('cash', 'bank', 'ewallet', 'credit_card', 'other') NOT NULL DEFAULT 'cash',
  currency CHAR(3) NOT NULL DEFAULT 'IDR',
  opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY unique_finance_account_name (user_id, name),
  INDEX idx_bank_wallet_account_user (user_id),
  CONSTRAINT fk_bank_wallet_account_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
);

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
  CONSTRAINT fk_saving_goals_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_saving_goals_account FOREIGN KEY (bank_wallet_account_id) REFERENCES bank_wallet_account(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  bank_wallet_account_id CHAR(36) NULL,
  category_id CHAR(36) NULL,
  transaction_type ENUM('expense', 'income', 'transfer') NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'IDR',
  description TEXT NULL,
  raw_text TEXT NULL,
  source ENUM('telegram', 'telegram_bot', 'mobile', 'web', 'import') NOT NULL DEFAULT 'telegram',
  source_message_id BIGINT NULL,
  source_chat_id BIGINT NULL,
  saving_goal_id CHAR(36) NULL,
  occurred_at DATETIME NOT NULL,
  sync_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  deleted_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_transactions_user_occurred (user_id, occurred_at),
  INDEX idx_transactions_user_sync (user_id, sync_version, updated_at),
  INDEX idx_transactions_source (source, source_message_id),
  INDEX idx_transactions_saving_goal (saving_goal_id),
  UNIQUE KEY unique_finance_entry_source (user_id, source, source_message_id),
  CONSTRAINT fk_transactions_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_transactions_bank_wallet_account
    FOREIGN KEY (bank_wallet_account_id) REFERENCES bank_wallet_account(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_transactions_category
    FOREIGN KEY (category_id) REFERENCES finance_categories(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_transactions_saving_goal
    FOREIGN KEY (saving_goal_id) REFERENCES saving_goals(id)
    ON DELETE SET NULL
);

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
  CONSTRAINT fk_saving_goal_entries_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transaction_drafts (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  bank_wallet_account_id CHAR(36) NULL,
  category_id CHAR(36) NULL,
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
  CONSTRAINT fk_transaction_drafts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_transaction_drafts_account FOREIGN KEY (bank_wallet_account_id) REFERENCES bank_wallet_account(id) ON DELETE SET NULL,
  CONSTRAINT fk_transaction_drafts_category FOREIGN KEY (category_id) REFERENCES finance_categories(id) ON DELETE SET NULL,
  CONSTRAINT fk_transaction_drafts_goal FOREIGN KEY (saving_goal_id) REFERENCES saving_goals(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS finance_savings (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  saving_name VARCHAR(255) NULL,
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
  UNIQUE KEY unique_finance_saving_source (user_id, source, source_message_id),
  CONSTRAINT fk_finance_savings_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS finance_sync_tokens (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_name VARCHAR(255) NOT NULL DEFAULT 'mobile',
  last_used_at TIMESTAMP NULL,
  expires_at TIMESTAMP NULL,
  revoked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY unique_finance_sync_token (token_hash),
  INDEX idx_finance_sync_tokens_user (user_id),
  CONSTRAINT fk_finance_sync_tokens_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS finance_receipts (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  transaction_id CHAR(36) NULL,
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
  INDEX idx_finance_receipts_source (source_chat_id, source_message_id),
  CONSTRAINT fk_finance_receipts_transaction
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_finance_receipts_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS finance_receipt_items (
  id CHAR(36) NOT NULL,
  receipt_id CHAR(36) NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  quantity DECIMAL(10,2) NULL,
  unit_price DECIMAL(15,2) NULL,
  line_total DECIMAL(15,2) NULL,
  category_name VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_finance_receipt_items_receipt (receipt_id),
  CONSTRAINT fk_finance_receipt_items_receipt
    FOREIGN KEY (receipt_id) REFERENCES finance_receipts(id)
    ON DELETE CASCADE
);
