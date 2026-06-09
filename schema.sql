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
);

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
  UNIQUE KEY unique_finance_category (user_id, transaction_type, slug),
  CONSTRAINT fk_finance_categories_user
    FOREIGN KEY (user_id) REFERENCES finance_users(id)
    ON DELETE CASCADE
);

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
  INDEX idx_finance_accounts_user (user_id),
  CONSTRAINT fk_finance_accounts_user
    FOREIGN KEY (user_id) REFERENCES finance_users(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS finance_entries (
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
  INDEX idx_finance_entries_user_occurred (user_id, occurred_at),
  INDEX idx_finance_entries_user_sync (user_id, sync_version, updated_at),
  INDEX idx_finance_entries_source (source, source_message_id),
  UNIQUE KEY unique_finance_entry_source (user_id, source, source_message_id),
  CONSTRAINT fk_finance_entries_user
    FOREIGN KEY (user_id) REFERENCES finance_users(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_finance_entries_account
    FOREIGN KEY (account_id) REFERENCES finance_accounts(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_finance_entries_category
    FOREIGN KEY (category_id) REFERENCES finance_categories(id)
    ON DELETE SET NULL
);

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
  INDEX idx_finance_sync_tokens_user (user_id),
  CONSTRAINT fk_finance_sync_tokens_user
    FOREIGN KEY (user_id) REFERENCES finance_users(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS finance_receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  entry_id BIGINT UNSIGNED NULL,
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
);

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
);
