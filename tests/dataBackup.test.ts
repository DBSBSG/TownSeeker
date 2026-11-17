import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createBackup,
  restoreBackup,
  verifyBackup,
} from "../server/dataBackup.mjs";
import { createUserStore } from "../server/userStore.mjs";
import { HuntStore } from "../src/ts/server/huntStore.js";
import { PlayerProfileStore } from "../src/ts/server/playerProfileStore.js";
import { PlayerProgressStore } from "../src/ts/server/playerProgressStore.js";
import { HuntIssueStore } from "../src/ts/server/huntIssueStore.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "townseeker-recovery-"));
  const data = join(root, "data");
  await mkdir(data);
  const hunts = new HuntStore(join(data, "hunts.json"));
  const hunt = await hunts.create(
    {
      name: "Recovery hunt",
      description: "Durable test data",
      beginsAt: "2026-01-01T00:00:00Z",
      endsAt: null,
      taskOrderMode: "any",
    },
    "owner",
  );
  await hunts.addTask(hunt.id, {
    displayLabel: "Landmark",
    description: "Read the sign",
    requiredAnswer: "Trail",
    location: { latitude: 35, longitude: -80 },
    order: 1,
    answerCaseSensitive: false,
    hint: null,
    points: 10,
  });
  const saved = await hunts.get(hunt.id);
  const account = `google-${sha("recovery-player")}`;
  await new PlayerProfileStore(join(data, "player-profiles.json")).save(
    account,
    { displayName: "Recovery Player" },
  );
  await new PlayerProgressStore(
    join(data, "account-player-progress.json"),
  ).complete(account, hunt.id, saved.tasks[0].id);
  await new HuntIssueStore(join(data, "hunt-issues.json")).submit(
    saved,
    { taskId: null, description: "Test issue" },
    account,
  );
  await writeFile(
    join(data, "hunt-contributors.json"),
    JSON.stringify({
      schemaVersion: 1,
      contributors: { [hunt.id]: [account] },
      invitations: {},
      roles: {},
      emails: {},
    }),
  );
  await writeFile(
    join(data, "organizations.json"),
    JSON.stringify({ schemaVersion: 1, organizations: [] }),
  );
  await writeFile(
    join(data, "kahoot-games.json"),
    JSON.stringify({ schemaVersion: 1, games: {} }),
  );
  await writeFile(
    join(data, "player-progress.json"),
    JSON.stringify({ schemaVersion: 1, players: {} }),
  );
  await writeFile(
    join(data, "auth-sessions.json"),
    JSON.stringify({ privateSession: "must-not-be-restored" }),
  );
  await writeFile(join(data, ".env"), "SECRET=must-not-be-backed-up");
  await createUserStore({ dataDir: data }).createUser("recovery-user", {
    displayName: "Test User",
  });
  return {
    root,
    data,
    hunt: saved,
    account,
    backup: join(root, "snapshot.townseeker-backup.json"),
    restored: join(root, "recovered"),
  };
}

test("backup and restore recover all durable stores through production readers without restoring sessions", async () => {
  const f = await fixture();
  try {
    const result = await createBackup({
      dataDirectory: f.data,
      output: f.backup,
      offline: true,
    });
    expect(result.count).toBe(9);
    const bundle = await verifyBackup(f.backup);
    const bytes = await readFile(f.backup, "utf8");
    expect(bytes).not.toContain("must-not-be-restored");
    expect(bytes).not.toContain("must-not-be-backed-up");
    // Simulate losing the original temporary data directory before recovery.
    await rm(f.data, { recursive: true });
    await restoreBackup({
      input: f.backup,
      dataDirectory: f.restored,
      offline: true,
    });
    expect(
      await new HuntStore(join(f.restored, "hunts.json")).get(f.hunt.id),
    ).toEqual(f.hunt);
    expect(
      await new PlayerProfileStore(
        join(f.restored, "player-profiles.json"),
      ).get(f.account),
    ).toEqual({ displayName: "Recovery Player" });
    expect(
      await new PlayerProgressStore(
        join(f.restored, "account-player-progress.json"),
      ).completed(f.account, f.hunt.id),
    ).toEqual([f.hunt.tasks[0].id]);
    expect(
      (await createUserStore({ dataDir: f.restored }).getUser("recovery-user"))
        .profile.displayName,
    ).toBe("Test User");
    for (const file of bundle.files)
      expect(await readFile(join(f.restored, file.path), "utf8")).toBe(
        file.content,
      );
    expect(await readdir(f.restored)).not.toContain("auth-sessions.json");
    if (process.platform !== "win32") {
      expect((await stat(f.backup)).mode & 0o777).toBe(0o600);
      expect((await stat(f.restored)).mode & 0o777).toBe(0o700);
      expect((await stat(join(f.restored, "hunts.json"))).mode & 0o777).toBe(
        0o600,
      );
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("offline acknowledgement is required and existing backup and restore targets remain untouched", async () => {
  const f = await fixture();
  try {
    await expect(
      createBackup({ dataDirectory: f.data, output: f.backup }),
    ).rejects.toThrow(/offline/);
    await createBackup({
      dataDirectory: f.data,
      output: f.backup,
      offline: true,
    });
    const original = await readFile(f.backup, "utf8");
    await expect(
      createBackup({ dataDirectory: f.data, output: f.backup, offline: true }),
    ).rejects.toThrow(/exists/);
    expect(await readFile(f.backup, "utf8")).toBe(original);
    await expect(
      restoreBackup({ input: f.backup, dataDirectory: f.restored }),
    ).rejects.toThrow(/offline/);
    await mkdir(f.restored);
    await writeFile(join(f.restored, "keep.txt"), "do not change");
    await expect(
      restoreBackup({
        input: f.backup,
        dataDirectory: f.restored,
        offline: true,
      }),
    ).rejects.toThrow(/exists/);
    expect(await readFile(join(f.restored, "keep.txt"), "utf8")).toBe(
      "do not change",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("restore rejects damaged checksums, duplicate/traversal paths, unsupported versions and bad JSON before writing", async () => {
  const f = await fixture();
  try {
    await createBackup({
      dataDirectory: f.data,
      output: f.backup,
      offline: true,
    });
    const original = await verifyBackup(f.backup);
    const variants = [
      { ...original, version: 2 },
      {
        ...original,
        files: [
          {
            path: "hunts.json",
            content: '{"schemaVersion":2,"hunts":[]}',
            sha256: sha('{"schemaVersion":2,"hunts":[]}'),
          },
        ],
      },
      {
        ...original,
        files: [
          {
            path: "hunts.json",
            content: '{"schemaVersion":1,"hunts":{}}',
            sha256: sha('{"schemaVersion":1,"hunts":{}}'),
          },
        ],
      },
      { ...original, files: [] },
      { ...original, files: [...original.files, original.files[0]] },
      {
        ...original,
        files: [{ ...original.files[0], path: "../outside.json" }],
      },
      {
        ...original,
        files: [{ ...original.files[0], path: "C:/outside.json" }],
      },
      {
        ...original,
        files: [{ ...original.files[0], sha256: "0".repeat(64) }],
      },
      {
        ...original,
        files: [
          {
            ...original.files[0],
            content: "not JSON",
            sha256: sha("not JSON"),
          },
        ],
      },
      {
        ...original,
        files: [
          { path: "auth-sessions.json", content: "{}", sha256: sha("{}") },
        ],
      },
    ];
    for (const variant of variants) {
      await writeFile(f.backup, JSON.stringify(variant));
      await expect(
        restoreBackup({
          input: f.backup,
          dataDirectory: f.restored,
          offline: true,
        }),
      ).rejects.toThrow();
      await expect(stat(f.restored)).rejects.toThrow();
    }
    await writeFile(f.backup, "not JSON");
    await expect(verifyBackup(f.backup)).rejects.toThrow(/JSON/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("backup rejects corrupt and unrecognized stores and symlinked data instead of creating incomplete archives", async () => {
  const f = await fixture();
  try {
    const original = await readFile(join(f.data, "hunts.json"), "utf8");
    await writeFile(join(f.data, "hunts.json"), "broken");
    await expect(
      createBackup({ dataDirectory: f.data, output: f.backup, offline: true }),
    ).rejects.toThrow(/JSON/);
    await expect(stat(f.backup)).rejects.toThrow();
    await writeFile(join(f.data, "hunts.json"), original);
    await writeFile(join(f.data, "future-store.json"), "{}");
    await expect(
      createBackup({ dataDirectory: f.data, output: f.backup, offline: true }),
    ).rejects.toThrow(/Unrecognized/);
    await rm(join(f.data, "future-store.json"));
    const alias = join(f.root, "alias");
    await symlink(
      f.data,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      createBackup({ dataDirectory: alias, output: f.backup, offline: true }),
    ).rejects.toThrow(/symlink/);
    await expect(
      createBackup({
        dataDirectory: f.data,
        output: join(f.data, "snapshot.json"),
        offline: true,
      }),
    ).rejects.toThrow(/outside/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("concurrent restores publish one complete directory and do not overwrite it", async () => {
  const f = await fixture();
  try {
    await createBackup({
      dataDirectory: f.data,
      output: f.backup,
      offline: true,
    });
    const results = await Promise.allSettled([
      restoreBackup({
        input: f.backup,
        dataDirectory: f.restored,
        offline: true,
      }),
      restoreBackup({
        input: f.backup,
        dataDirectory: f.restored,
        offline: true,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await new HuntStore(join(f.restored, "hunts.json")).get(f.hunt.id),
    ).toEqual(f.hunt);
    expect(
      (await readdir(f.root)).filter((name) =>
        name.startsWith(".townseeker-restore-"),
      ),
    ).toEqual([]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("CLI verify/restore work without cloud credentials and reject missing or unexpected flags", async () => {
  const f = await fixture();
  const cli = resolve("server/dataBackup.mjs");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  try {
    expect(
      run("backup", "--data-dir", f.data, "--output", f.backup).status,
    ).toBe(1);
    expect(
      run("backup", "--data-dir", f.data, "--output", f.backup, "--offline")
        .status,
    ).toBe(0);
    expect(run("verify", "--input", f.backup).status).toBe(0);
    expect(
      run("restore", "--input", f.backup, "--data-dir", f.restored, "--offline")
        .status,
    ).toBe(0);
    expect(run("verify", "--input", f.backup, "--surprise").status).toBe(1);
    expect(run("restore", "--input", f.backup, "--offline").status).toBe(1);
    expect(run("backup", "--help").stdout).toContain("--offline");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
