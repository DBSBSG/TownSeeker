import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = new URL("../src/js/server/hostinger.js", import.meta.url).href;

for (const googleConfigured of [false, true]) {
  test(`Hostinger-style import starts a real HTTP server with Google ${googleConfigured ? "configured" : "disabled"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "townseeker-startup-"));
    try {
      const env = {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0",
        DATA_DIRECTORY: directory,
        APP_ORIGIN: "https://startup.example.com",
        GOOGLE_CLIENT_ID: googleConfigured
          ? "startup.apps.googleusercontent.com"
          : "",
        ADMIN_EMAILS: "",
      };
      delete env.ORIGIN_TOKEN;
      const script = `
        import { once } from 'node:events';
        // --eval has no entry-file argv: the application must start on import.
        const { app } = await import(${JSON.stringify(entry)});
        if (!app.listening) await once(app, 'listening');
        try {
          const base = 'http://127.0.0.1:' + app.address().port;
          const health = await fetch(base + '/api/health');
          const healthBody = await health.json();
          const page = await fetch(base + '/');
          const pageBody = await page.text();
          const auth = await fetch(base + '/api/auth/config');
          const authBody = await auth.json();
          const session = await fetch(base + '/api/auth/session');
          await session.text();
          console.log(JSON.stringify({ health: health.status, healthBody, page: page.status, title: pageBody.includes('TownSeeker'), auth: auth.status, authBody, session: session.status }));
        } finally {
          app.closeAllConnections();
          await new Promise(resolve => app.close(resolve));
        }
      `;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
          env,
          encoding: "utf8",
          timeout: 15000,
          cwd: new URL("../", import.meta.url),
        },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
      assert.equal(output.health, 200);
      assert.equal(output.page, 200);
      assert.equal(output.title, true);
      assert.equal(output.auth, googleConfigured ? 200 : 503);
      assert.equal(output.session, googleConfigured ? 401 : 503);
      if (googleConfigured) {
        assert.equal(output.authBody.clientId, env.GOOGLE_CLIENT_ID);
        assert.match(output.authBody.nonce, /^[a-f0-9]{64}$/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
