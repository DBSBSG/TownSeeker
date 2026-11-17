import { expect, test } from "@playwright/test";

// BASE_URL selects the deployed service; ordinary CI starts the local server.
test.use({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3000" });

test("landing page keeps player navigation behind sign-in", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/TownSeeker/);
  await expect(page.getByTestId("google-sign-in")).toBeAttached();
  await expect(page.getByRole("navigation")).toHaveCount(0);
});

test("admin workspace waits for Hunt Studio controls to load", async ({
  page,
}) => {
  let releaseBootstrap!: () => void;
  const bootstrapReady = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  const administrator = {
    subject: "google-subject-admin",
    email: "admin@example.com",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    role: "administrator",
  };

  await page.route("**/js/foundation/bootstrap.js", async (route) => {
    await bootstrapReady;
    await route.continue();
  });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { user: administrator } }),
  );
  await page.route("**/api/admin/capabilities", (route) =>
    route.fulfill({
      json: { administrator, capabilities: ["administrative.access"] },
    }),
  );

  await page.goto("/admin.html", { waitUntil: "commit" });
  await page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/admin/capabilities",
  );
  await expect(page.getByTestId("admin-workspace")).toBeHidden();

  releaseBootstrap();
  await expect(page.getByTestId("admin-workspace")).toBeVisible();
  await page.getByTestId("open-create-hunt").click();
  await expect(page.getByTestId("hunt-form")).toBeVisible();
});

test("shared Google sign-in checks the server admin role", async ({ page }) => {
  let authenticated = false;
  const administrator = {
    subject: "google-subject-123",
    email: "admin@example.com",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    role: "administrator",
  };
  const sessionUser = { ...administrator, role: "user" as const };

  await page.addInitScript(() => {
    type Callback = (response: { credential: string }) => void;
    const testWindow = window as typeof window & {
      google?: {
        accounts: {
          id: {
            initialize(options: { callback: Callback }): void;
            renderButton(parent: HTMLElement): void;
            disableAutoSelect(): void;
          };
        };
      };
      googleCallback?: Callback;
    };
    testWindow.google = {
      accounts: {
        id: {
          initialize(options) {
            testWindow.googleCallback = options.callback;
          },
          renderButton(parent) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Sign in with Google";
            button.addEventListener("click", () => {
              testWindow.googleCallback?.({
                credential: "verified-test-token",
              });
            });
            parent.replaceChildren(button);
          },
          disableAutoSelect() {},
        },
      },
    };
  });

  await page.route("**/api/player/account/profile", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          displayName:
            route.request().method() === "PUT"
              ? route.request().postDataJSON().displayName
              : null,
        },
      },
    }),
  );
  await page.route("**/api/player/account/hunts", (route) =>
    route.fulfill({ json: { ok: true, value: [] } }),
  );

  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") {
      await route.fulfill({
        json: { clientId: "test-client-id", nonce: "single-use-test-nonce" },
      });
      return;
    }
    if (path === "/api/auth/session") {
      await route.fulfill({
        status: authenticated ? 200 : 401,
        json: authenticated
          ? { user: sessionUser }
          : { error: "Sign-in required." },
      });
      return;
    }
    if (path === "/api/auth/login") {
      authenticated = true;
      await route.fulfill({ json: { user: sessionUser } });
      return;
    }
    if (path === "/api/auth/logout") {
      authenticated = false;
      await route.fulfill({ json: { signedOut: true } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found." } });
  });
  await page.route("**/api/admin/capabilities", (route) =>
    route.fulfill({
      json: { administrator, capabilities: ["administrative.access"] },
    }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page).toHaveURL(/player\.html$/);
  await expect(page.getByTestId("player-name-form")).toBeVisible();
  await page.getByTestId("player-display-name-input").fill("Baja");
  await page.getByRole("button", { name: "Save name and continue" }).click();
  await expect(page.getByTestId("player-account-menu")).toBeVisible();
  await expect(page.getByTestId("player-display-name")).toHaveText(
    "Baja (Admin)",
  );
  await page.getByRole("link", { name: "Hunt Studio", exact: true }).click();
  await expect(page.locator("#admin-status")).toHaveText(
    "Administrator access verified.",
  );
  await expect(page.locator("#admin-access")).toBeHidden();
  await expect(page.locator("#admin-workspace")).toBeVisible();
  await expect(page.getByTestId("hunt-form")).toBeHidden();
  await page.getByTestId("open-create-hunt").click();
  await expect(page.getByTestId("hunt-form")).toBeVisible();
  await page.getByTestId("close-create-hunt").click();
  await page.getByTestId("open-manage-hunts").click();
  await expect(page.getByTestId("manage-hunts-view")).toBeVisible();
  await page.getByTestId("close-hunt-details").click();
  await expect(page.getByTestId("admin-account-menu")).toBeVisible();
  await expect(page.getByTestId("admin-display-name")).toContainText("(Admin)");
  await page.getByTestId("admin-account").click();
  await expect(page.getByTestId("admin-sign-out")).toBeVisible();
  await page.getByTestId("admin-sign-out").click();
  await expect(page.locator("#admin-workspace")).toBeHidden();
  await expect(page.locator("#admin-login")).toBeVisible();
  await expect(page.locator("#home-sign-in-link")).toBeVisible();
});

test("admin sign-in prompt stays hidden while session is loading", async ({
  page,
}) => {
  let finishSessionCheck!: () => void;
  const sessionCheck = new Promise<void>((resolve) => {
    finishSessionCheck = resolve;
  });
  const administrator = {
    subject: "google-subject-admin",
    email: "admin@example.com",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    role: "administrator",
  };

  await page.route("**/api/auth/session", async (route) => {
    await sessionCheck;
    await route.fulfill({ json: { user: administrator } });
  });
  await page.route("**/api/admin/capabilities", (route) =>
    route.fulfill({
      json: { administrator, capabilities: ["administrative.access"] },
    }),
  );

  await page.goto("/admin.html");
  await expect(page.locator("#admin-login")).toBeHidden();
  await expect(page.locator("#admin-status")).toHaveText(
    "Checking administrator session...",
  );

  finishSessionCheck();
  await expect(page.locator("#admin-workspace")).toBeVisible();
});

test("non-admin Google accounts cannot view Hunt Studio tools", async ({
  page,
}) => {
  const visitor = {
    subject: "google-subject-visitor",
    email: "visitor@example.com",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    role: "user",
  };
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { user: visitor } }),
  );

  await page.route("**/api/admin/capabilities", (route) =>
    route.fulfill({
      status: 403,
      json: { error: "Administrator access required." },
    }),
  );

  await page.goto("/admin.html");
  await expect(page.locator("#admin-denied")).toBeVisible();
  await expect(page.getByTestId("admin-workspace")).toBeHidden();
  await expect(page.getByTestId("hunt-form")).toBeHidden();
  await expect(page.getByTestId("admin-account-menu")).toBeVisible();
  await expect(page.getByTestId("admin-display-name")).not.toContainText(
    "(Admin)",
  );
  await page.getByTestId("admin-account").click();
  await expect(page.getByTestId("admin-sign-out")).toBeVisible();
});

test("player account endpoints require bearer identity and never issue cookies", async ({
  request,
}) => {
  const config = await request.get("/api/player/account/config");
  expect(config.headers()["set-cookie"]).toBeUndefined();
  const payload = await config.json();
  if (process.env.BASE_URL || process.env.GOOGLE_CLIENT_ID) {
    expect(config.status()).toBe(200);
    expect(payload).toEqual({
      ok: true,
      value: { clientId: expect.any(String) },
    });
    expect(payload.value.clientId).not.toBe("");
  } else {
    expect(config.status()).toBe(503);
    expect(payload.ok).toBe(false);
  }
  const response = await request.get("/api/player/account/hunts", {
    headers: {
      Cookie: "townseeker-player=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    },
  });
  expect(response.status()).toBe(401);
  expect(response.headers()["set-cookie"]).toBeUndefined();
  expect((await response.json()).code).toBe("unauthorized");
});

// These tests make real HTTP requests only: no Google mocks, database access,
// test users, or writes to hunt/player data on the deployed service.
// Successful Google login and data durability need separate migration QA.
test.describe("@live-deployment Hostinger smoke checks", () => {
  test.skip(!process.env.BASE_URL, "Requires a deployed BASE_URL.");

  test("serves application pages and browser assets", async ({ request }) => {
    for (const [path, marker] of [
      ["/", 'data-testid="google-sign-in"'],
      ["/admin.html", 'data-testid="admin-workspace"'],
      ["/player.html", 'data-testid="player-name-form"'],
    ]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
      const html = await response.text();
      expect(html).toContain(marker);
      // Both existing TownSeeker assets and future rebranded assets are checked
      // from the actual page, rather than hardcoding a logo name or title.
      const assets = Array.from(
        html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css|svg|png))"/g),
        (match) => new URL(match[1], response.url()),
      ).filter((url) => url.origin === new URL(response.url()).origin);
      expect(
        assets.length,
        `No application assets found on ${path}`,
      ).toBeGreaterThan(0);
      for (const asset of assets) {
        const result = await request.get(asset.href, { maxRedirects: 0 });
        expect(result.status(), asset.pathname).toBe(200);
        expect(result.headers()["content-type"], asset.pathname).not.toContain(
          "text/html",
        );
      }
    }
  });

  test("serves configured Google identity and denies unauthenticated APIs", async ({
    request,
  }) => {
    const expectedClientId = process.env.GOOGLE_CLIENT_ID;
    expect(
      expectedClientId,
      "Set GOOGLE_CLIENT_ID to the new public OAuth client ID",
    ).toBeTruthy();
    const config = await request.get("/api/player/account/config");
    expect(config.status()).toBe(200);
    expect(config.headers()["cache-control"]).toContain("no-store");
    expect(await config.json()).toEqual({
      ok: true,
      value: { clientId: expectedClientId },
    });

    for (const path of [
      "/api/auth/session",
      "/api/admin/capabilities",
      "/api/player/account/hunts",
    ]) {
      for (const headers of [
        {},
        { Cookie: `__Host-townseeker-session=${"a".repeat(64)}` },
      ]) {
        const response = await request.get(path, { headers, maxRedirects: 0 });
        expect(response.status(), path).toBe(401);
        expect(response.headers()["content-type"]).toContain(
          "application/json",
        );
        expect(response.headers()["cache-control"]).toContain("no-store");
        const payload = await response.json();
        expect(payload.user).toBeUndefined();
        expect(payload.administrator).toBeUndefined();
      }
    }
  });

  test("issues private nonces and rejects cross-origin and invalid login", async ({
    request,
  }) => {
    const origin = new URL(process.env.BASE_URL!).origin;
    const config = await request.get("/api/auth/config");
    expect(config.status()).toBe(200);
    expect(config.headers()["cache-control"]).toContain("no-store");
    const { clientId, nonce } = await config.json();
    expect(
      process.env.GOOGLE_CLIENT_ID,
      "Set GOOGLE_CLIENT_ID for live checks",
    ).toBeTruthy();
    expect(clientId).toBe(process.env.GOOGLE_CLIENT_ID);
    expect(nonce).toMatch(/^[a-f0-9]{64}$/);
    const cookie = config
      .headersArray()
      .find(
        (header) =>
          header.name.toLowerCase() === "set-cookie" &&
          header.value.startsWith("__Host-townseeker-login="),
      )?.value;
    expect(cookie, "The login nonce must be browser-bound").toBeTruthy();
    expect(cookie).toMatch(/;\s*Secure(?:;|$)/i);
    expect(cookie).toMatch(/;\s*HttpOnly(?:;|$)/i);
    expect(cookie).toMatch(/;\s*SameSite=Strict(?:;|$)/i);
    expect(cookie).toMatch(/;\s*Path=\/(?:;|$)/i);
    expect(cookie).not.toMatch(/;\s*Domain=/i);
    const headers = { Cookie: cookie!.split(";")[0] };
    const crossOrigin = await request.post("/api/auth/login", {
      headers: { ...headers, Origin: "https://invalid.example" },
      data: { credential: "invalid" },
    });
    expect(crossOrigin.status()).toBe(403);
    const invalid = await request.post("/api/auth/login", {
      headers: { ...headers, Origin: origin },
      data: { credential: "invalid" },
    });
    expect(invalid.status()).toBe(401);
    expect(invalid.headers()["cache-control"]).toContain("no-store");
    expect((await invalid.json()).user).toBeUndefined();
    const fresh = await request.get("/api/auth/config");
    expect(fresh.status()).toBe(200);
    expect((await fresh.json()).nonce).not.toBe(nonce);
    expect((await request.get("/api/auth/session")).status()).toBe(401);
  });
});
