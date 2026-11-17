import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createApplication } from "../src/ts/server/server.js";
import { FileSessionStore } from "../src/ts/server/authSessionStore.js";

const origin = "https://townseeker.example";
const identity = { subject: "test-admin", email: "admin@example.com" };
const options = {
  appOrigin: origin,
  googleClientId: "test-client",
  adminEmails: [identity.email],
};
const headers = { Origin: origin, "Content-Type": "application/json" };

async function start(directory: string, adminEmails = options.adminEmails) {
  const app = createApplication({
    ...options,
    adminEmails,
    dataDirectory: directory,
    verifyAuthCredential: async () => identity,
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  return {
    base,
    close: () =>
      !app.listening
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) =>
            app.close((error) => (error ? reject(error) : resolve())),
          ),
  };
}
async function begin(base: string) {
  const response = await fetch(base + "/api/auth/config");
  expect(response.status).toBe(200);
  return {
    cookie: response.headers.getSetCookie()[0].split(";")[0],
    payload: await response.json(),
  };
}
async function login(base: string, cookie: string) {
  return fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify({ credential: "test-credential" }),
  });
}

test("Node HTTP authentication persists across a process restart, recalculates roles, and revokes logout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "townseeker-auth-"));
  let server = await start(directory);
  try {
    const pending = await begin(server.base);
    expect(pending.payload.clientId).toBe(options.googleClientId);
    const response = await login(server.base, pending.cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).user.role).toBe("administrator");
    const cookie = response.headers.getSetCookie()[0].split(";")[0];
    expect(
      (
        await fetch(server.base + "/api/admin/capabilities", {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(200);
    const stored = await readFile(
      join(directory, "auth-sessions.json"),
      "utf8",
    );
    expect(stored).not.toContain(cookie.split("=")[1]);
    expect(stored).not.toContain("test-credential");
    await server.close();

    // A separate OS process reads the persisted session, without any test verifier.
    const moduleUrl = pathToFileURL(resolve("src/js/server/server.js")).href;
    const script = `import {createApplication} from ${JSON.stringify(moduleUrl)}; const app=createApplication(${JSON.stringify({ ...options, dataDirectory: directory, adminEmails: [] })});app.listen(0,'127.0.0.1',()=>process.send(app.address().port));`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    try {
      const [port] = await once(child, "message");
      const base = `http://127.0.0.1:${port}`;
      const session = await fetch(base + "/api/auth/session", {
        headers: { Cookie: cookie },
      });
      expect(session.status).toBe(200);
      expect((await session.json()).user.role).toBe("user");
      expect(
        (
          await fetch(base + "/api/admin/capabilities", {
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(base + "/api/auth/logout", {
            method: "POST",
            headers: { ...headers, Cookie: cookie },
            body: "{}",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(base + "/api/auth/session", {
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(401);
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    server = await start(directory);
    expect(
      (
        await fetch(server.base + "/api/auth/session", {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP adapter preserves nonce replay, origin, malformed-body, and unauthenticated protections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "townseeker-auth-"));
  const server = await start(directory);
  try {
    for (const path of ["/api/auth/session", "/api/admin/capabilities"]) {
      expect((await fetch(server.base + path)).status).toBe(401);
    }
    const pending = await begin(server.base);
    const denied = await fetch(server.base + "/api/auth/login", {
      method: "POST",
      headers: {
        ...headers,
        Origin: "https://other.example",
        Cookie: pending.cookie,
      },
      body: '{"credential":"test"}',
    });
    expect(denied.status).toBe(403);
    for (const body of ["{", " ".repeat(16385)]) {
      expect(
        (
          await fetch(server.base + "/api/auth/login", {
            method: "POST",
            headers: { ...headers, Cookie: pending.cookie },
            body,
          })
        ).status,
      ).toBe(400);
    }
    const results = await Promise.all([
      login(server.base, pending.cookie),
      login(server.base, pending.cookie),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    const privateFile = await fetch(server.base + "/auth-sessions.json");
    expect(privateFile.status).toBe(404);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("file session store atomically consumes nonces, expires records, and preserves corrupt data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "townseeker-auth-"));
  const path = join(directory, "auth-sessions.json");
  try {
    const store = new FileSessionStore(path);
    const key = `login:${"a".repeat(64)}`;
    await store.put(key, {
      kind: "login",
      subject: "",
      email: "",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    const results = await Promise.all([
      store.take(key),
      new FileSessionStore(path).take(key),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const expired = `session:${"b".repeat(64)}`;
    await store.put(expired, {
      kind: "session",
      ...identity,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    expect(await store.get(expired)).toBeUndefined();
    await store.put(key, {
      kind: "login",
      subject: "",
      email: "",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    expect(await readFile(path, "utf8")).not.toContain(expired);
    await writeFile(path, "broken JSON");
    await expect(store.get(key)).rejects.toThrow();
    await expect(store.take(key)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("broken JSON");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing or unsafe auth origin fails closed and public data storage is rejected", async () => {
  for (const appOrigin of [
    undefined,
    "https://example.com/path",
    "http://public.example",
  ]) {
    const app = createApplication({ ...options, appOrigin });
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    try {
      expect(
        (
          await fetch(
            `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/auth/config`,
          )
        ).status,
      ).toBe(503);
    } finally {
      await new Promise<void>((resolve) => app.close(() => resolve()));
    }
  }
  expect(() =>
    createApplication({ dataDirectory: "src/private-data" }),
  ).toThrow(/outside/);
});
