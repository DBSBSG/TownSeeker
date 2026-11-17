import { JsonFile } from "./huntStore.js";
import type { SessionStore, StoredSession } from "./auth.js";

interface SessionFile {
  schemaVersion: 1;
  records: Record<string, StoredSession>;
}

function validate(value: unknown): SessionFile {
  const data = value as SessionFile;
  if (
    !data ||
    data.schemaVersion !== 1 ||
    !data.records ||
    typeof data.records !== "object" ||
    Array.isArray(data.records)
  )
    throw new Error("Invalid authentication session store");
  for (const [key, record] of Object.entries(data.records)) {
    if (
      !/^(login|session):[a-f0-9]{64}$/.test(key) ||
      !record ||
      record.kind !== key.split(":")[0] ||
      typeof record.subject !== "string" ||
      typeof record.email !== "string" ||
      !Number.isSafeInteger(record.expiresAt) ||
      record.expiresAt <= 0 ||
      (record.kind === "session" && (!record.subject || !record.email))
    )
      throw new Error("Invalid authentication session record");
  }
  return data;
}

// JsonFile serializes operations by absolute path within one Node.js process,
// writes private (0600) files atomically, and preserves corrupt files on failure.
// Multiple application processes must use a shared transactional database instead.
export class FileSessionStore implements SessionStore {
  private readonly file: JsonFile<SessionFile>;
  constructor(path: string) {
    this.file = new JsonFile(
      path,
      () => ({ schemaVersion: 1, records: {} }),
      validate,
    );
  }
  async get(key: string): Promise<StoredSession | undefined> {
    const record = (await this.file.get()).records[key];
    return record && record.expiresAt > Date.now() / 1000 ? record : undefined;
  }
  async put(key: string, value: StoredSession): Promise<void> {
    await this.file.update((data) => {
      for (const [id, record] of Object.entries(data.records)) {
        if (record.expiresAt <= Date.now() / 1000) delete data.records[id];
      }
      data.records[key] = value;
    });
  }
  async take(key: string): Promise<StoredSession | undefined> {
    return this.file.update((data) => {
      const record = data.records[key];
      delete data.records[key];
      return record && record.expiresAt > Date.now() / 1000
        ? record
        : undefined;
    });
  }
}
