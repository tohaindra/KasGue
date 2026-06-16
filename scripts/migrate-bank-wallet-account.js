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

async function columnExists(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tableName, columnName],
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

try {
  if ((await tableExists("finance_accounts")) && !(await tableExists("bank_wallet_account"))) {
    await db.query("RENAME TABLE finance_accounts TO bank_wallet_account");
  }
  if (
    (await columnExists("transactions", "account_id")) &&
    !(await columnExists("transactions", "bank_wallet_account_id"))
  ) {
    await db.query(
      "ALTER TABLE transactions RENAME COLUMN account_id TO bank_wallet_account_id",
    );
  }

  await dropForeignKey("transactions", "fk_transactions_account");
  if (!(await foreignKeyExists("transactions", "fk_transactions_bank_wallet_account"))) {
    await db.query(
      `ALTER TABLE transactions
       ADD CONSTRAINT fk_transactions_bank_wallet_account
       FOREIGN KEY (bank_wallet_account_id) REFERENCES bank_wallet_account(id)
       ON DELETE SET NULL`,
    );
  }

  await dropForeignKey("bank_wallet_account", "fk_finance_accounts_user");
  if (!(await foreignKeyExists("bank_wallet_account", "fk_bank_wallet_account_user"))) {
    const userTable = (await tableExists("users")) ? "users" : "finance_users";
    await db.query(
      `ALTER TABLE bank_wallet_account
       ADD CONSTRAINT fk_bank_wallet_account_user
       FOREIGN KEY (user_id) REFERENCES ${userTable}(id)
       ON DELETE CASCADE`,
    );
  }

  console.log("Account table standardized as bank_wallet_account.");
} finally {
  await db.end();
}
