import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const runtimeFiles = new Map([
  ["hunts.json", ["hunts", "array"]],
  ["hunt-contributors.json", ["contributors", "object"]],
  ["player-progress.json", ["players", "object"]],
  ["account-player-progress.json", ["players", "object"]],
  ["player-profiles.json", ["profiles", "object"]],
  ["organizations.json", ["organizations", "array"]],
  ["kahoot-games.json", ["games", "object"]],
  ["hunt-issues.json", null],
]);
const excludedFiles = new Set([
  "auth-sessions.json",
  "hunts.example.json",
  "hunts.schema.json",
  "user-data.schema.json",
]);
const publicDirectory = fileURLToPath(new URL("../src", import.meta.url));
const maximumBytes = 256 * 1024 * 1024;
const digest = (content) => createHash("sha256").update(content).digest("hex");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const userPath = (path) => /^users\/[a-f0-9]{64}\.json$/.test(path);
const within = (child, parent) => {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep))
  );
};

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function requiredPath(path, label) {
  if (typeof path !== "string" || !path.trim())
    throw new Error(`${label} is required.`);
  const absolute = resolve(path);
  if (dirname(absolute) === absolute)
    throw new Error(`${label} cannot be a filesystem root.`);
  if (within(absolute, publicDirectory))
    throw new Error(`${label} must be outside the public src directory.`);
  return absolute;
}
// Resolve parent aliases too, so a symlink cannot bypass the public-directory rule.
async function safeParent(path) {
  const parent = await realpath(dirname(path));
  if (within(parent, await realpath(publicDirectory)))
    throw new Error("Storage must be outside the public src directory.");
  return parent;
}
function validateData(path, content) {
  if (typeof content !== "string")
    throw new Error(`Invalid content for ${path}.`);
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in ${path}.`);
  }
  if (path === "hunt-issues.json") {
    if (!Array.isArray(value))
      throw new Error(`Invalid store format: ${path}.`);
    return;
  }
  const fields = runtimeFiles.get(path);
  if (!fields && !userPath(path))
    throw new Error(`Unsupported data path: ${path}.`);
  if (!object(value) || value.schemaVersion !== 1)
    throw new Error(`Unsupported store version: ${path}.`);
  if (userPath(path)) {
    if (
      !object(value.profile) ||
      !Array.isArray(value.hunts) ||
      typeof value.profile.id !== "string" ||
      path !== `users/${digest(value.profile.id)}.json`
    )
      throw new Error(`Invalid user store: ${path}.`);
  } else if (
    fields[1] === "array"
      ? !Array.isArray(value[fields[0]])
      : !object(value[fields[0]])
  ) {
    throw new Error(`Invalid store format: ${path}.`);
  }
}

export async function verifyBackup(input) {
  const path = requiredPath(input, "Backup input");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes)
    throw new Error("Backup must be a regular file under 256 MiB.");
  let bundle;
  try {
    bundle = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Backup is not valid JSON.");
  }
  if (
    !object(bundle) ||
    bundle.format !== "townseeker-backup" ||
    bundle.version !== 1 ||
    typeof bundle.createdAt !== "string" ||
    !Number.isFinite(Date.parse(bundle.createdAt)) ||
    !Array.isArray(bundle.files) ||
    bundle.files.length === 0
  )
    throw new Error("Unsupported or empty backup.");
  const names = new Set();
  for (const file of bundle.files) {
    if (
      !object(file) ||
      typeof file.path !== "string" ||
      names.has(file.path) ||
      (!runtimeFiles.has(file.path) && !userPath(file.path))
    )
      throw new Error("Invalid or duplicate backup path.");
    names.add(file.path);
    validateData(file.path, file.content);
    if (typeof file.sha256 !== "string" || file.sha256 !== digest(file.content))
      throw new Error(`Checksum mismatch: ${file.path}.`);
  }
  return bundle;
}

export async function createBackup({ dataDirectory, output, offline = false }) {
  if (!offline)
    throw new Error(
      "Stop the application, then pass --offline to confirm it is stopped.",
    );
  const directory = requiredPath(dataDirectory, "Data directory");
  const source = await lstat(directory);
  if (!source.isDirectory() || source.isSymbolicLink())
    throw new Error("Data directory must be a real directory, not a symlink.");
  const actualSource = await realpath(directory);
  if (within(actualSource, await realpath(publicDirectory)))
    throw new Error("Data must be outside the public src directory.");
  const destination = requiredPath(output, "Backup output");
  if (within(destination, directory))
    throw new Error("Write backups outside the data directory.");
  if (await exists(destination))
    throw new Error("Backup output already exists; choose a new file.");
  // The destination parent must already exist: do not create arbitrary path trees.
  const parent = await safeParent(destination);
  if (within(parent, actualSource))
    throw new Error("Write backups outside the data directory.");
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (runtimeFiles.has(entry.name)) paths.push(entry.name);
    else if (entry.name === "users") {
      const users = resolve(directory, "users");
      const info = await lstat(users);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("User store must be a real directory.");
      for (const file of await readdir(users)) {
        if (!userPath(`users/${file}`))
          throw new Error(
            "Unexpected file in user store; inspect it before backing up.",
          );
        paths.push(`users/${file}`);
      }
    } else if (entry.name.endsWith(".json") && !excludedFiles.has(entry.name)) {
      throw new Error(
        `Unrecognized JSON store: ${entry.name}. Update the backup tool before proceeding.`,
      );
    }
  }
  if (!paths.length) throw new Error("No runtime data files found.");
  const files = [];
  let bytes = 0;
  for (const path of paths.sort()) {
    const fullPath = resolve(directory, path);
    const info = await lstat(fullPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes)
      throw new Error(`Unsafe data file: ${path}.`);
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(await readFile(fullPath));
    bytes += Buffer.byteLength(content);
    if (bytes > maximumBytes)
      throw new Error("Data exceeds the 256 MiB backup limit.");
    validateData(path, content);
    files.push({ path, sha256: digest(content), content });
  }
  const bundle = {
    format: "townseeker-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    files,
  };
  const serialized = JSON.stringify(bundle) + "\n";
  if (Buffer.byteLength(serialized) > maximumBytes)
    throw new Error("Serialized backup exceeds 256 MiB.");
  // Exclusive creation guarantees an existing backup is never overwritten.
  const file = await open(destination, "wx", 0o600);
  try {
    await file.writeFile(serialized);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(destination);
    throw error;
  }
  await file.close();
  return { path: destination, count: files.length };
}

export async function restoreBackup({ input, dataDirectory, offline = false }) {
  if (!offline)
    throw new Error(
      "Stop the application, then pass --offline to confirm it is stopped.",
    );
  // Validate the entire archive before creating any restore files.
  const bundle = await verifyBackup(input);
  let destination = requiredPath(dataDirectory, "Restore directory");
  const parent = await safeParent(destination);
  destination = resolve(parent, basename(destination));
  if (await exists(destination))
    throw new Error(
      "Restore directory already exists. Restore into a new directory.",
    );
  const staging = resolve(parent, `.townseeker-restore-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  let claimed = false;
  try {
    for (const entry of bundle.files) {
      const path = resolve(staging, entry.path);
      // Paths were allowlisted by verifyBackup, and staging is private/new.
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(entry.content);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    // Reserve the new destination exclusively. Concurrent restores cannot replace it.
    await mkdir(destination, { mode: 0o700 });
    claimed = true;
    for (const name of await readdir(staging))
      await rename(resolve(staging, name), resolve(destination, name));
    return { path: destination, count: bundle.files.length };
  } catch (error) {
    // Remove only the exact new target this invocation successfully reserved.
    if (claimed && within(destination, parent) && destination !== parent)
      await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    // staging is a unique child of the verified parent, never an input path.
    if (dirname(staging) === parent)
      await rm(staging, { recursive: true, force: true });
  }
}

const usage = `Usage:
  pnpm data:backup --data-dir <stopped-data-dir> --output <new-backup-file> --offline
  pnpm data:verify --input <backup-file>
  pnpm data:restore --input <backup-file> --data-dir <new-data-dir> --offline
Parent directories must exist. Backups contain private data and are not encrypted.
Login sessions/nonces are excluded. Keep the application stopped until restore completes.`;

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "--help" || args.includes("--help")) console.log(usage);
    else {
      if (!["backup", "verify", "restore"].includes(command))
        throw new Error(usage);
      const options = {};
      for (let index = 0; index < args.length; index++) {
        const option = args[index];
        if (option === "--offline" && options.offline === undefined)
          options.offline = true;
        else {
          const key = {
            "--data-dir": "dataDirectory",
            "--output": "output",
            "--input": "input",
          }[option];
          if (
            !key ||
            options[key] !== undefined ||
            !args[index + 1] ||
            args[index + 1].startsWith("--")
          )
            throw new Error(`Invalid or duplicate option: ${option}.`);
          options[key] = args[++index];
        }
      }
      const allowed = {
        backup: ["dataDirectory", "output", "offline"],
        verify: ["input"],
        restore: ["dataDirectory", "input", "offline"],
      }[command];
      if (Object.keys(options).some((key) => !allowed.includes(key)))
        throw new Error("Option is not supported for this command.");
      const result =
        command === "backup"
          ? await createBackup(options)
          : command === "restore"
            ? await restoreBackup(options)
            : { count: (await verifyBackup(options.input)).files.length };
      console.log(
        `${command} completed: ${result.count} data files${result.path ? ` (${result.path})` : ""}.`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
