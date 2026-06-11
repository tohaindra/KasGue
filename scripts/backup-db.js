import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, getConfig } from "../src/config.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function backupFileName(database) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${database}-${timestamp}.sql`;
}

export async function backupDatabase() {
  const config = getConfig();
  const backupDirectory = path.resolve(projectRoot, env("DB_BACKUP_DIR") || "backups");
  const backupPath = path.join(backupDirectory, backupFileName(config.mysql.database));
  const dockerContainer = env("MYSQL_DOCKER_CONTAINER");
  const executable = dockerContainer ? "docker" : env("MYSQLDUMP_PATH") || "mysqldump";

  await mkdir(backupDirectory, { recursive: true });

  const dumpArgs = [
    `--host=${config.mysql.host}`,
    `--port=${config.mysql.port}`,
    `--user=${config.mysql.user}`,
    "--single-transaction",
    "--quick",
    "--routines",
    "--triggers",
    "--events",
    "--hex-blob",
    "--default-character-set=utf8mb4",
    "--databases",
    config.mysql.database,
  ];
  const args = dockerContainer
    ? [
        "exec",
        "-e",
        `MYSQL_PWD=${config.mysql.password}`,
        dockerContainer,
        "mysqldump",
        ...dumpArgs,
      ]
    : dumpArgs;

  const output = createWriteStream(backupPath, { flags: "wx" });
  const child = spawn(executable, args, {
    env: dockerContainer ? process.env : { ...process.env, MYSQL_PWD: config.mysql.password },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.pipe(output);
  let errorText = "";
  child.stderr.on("data", (chunk) => {
    errorText += chunk.toString();
  });

  try {
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      output.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(errorText.trim() || `mysqldump exited with code ${code}`));
      });
    });
    await new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      if (output.closed) resolve();
    });
    const file = await stat(backupPath);
    if (!file.size) throw new Error("File backup kosong.");
    console.log(`Database backup completed: ${backupPath}`);
    return backupPath;
  } catch (error) {
    output.destroy();
    await rm(backupPath, { force: true });
    throw new Error(`Database backup failed. Migration dibatalkan. ${error.message}`);
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  await backupDatabase();
}
