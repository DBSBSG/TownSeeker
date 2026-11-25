import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const slotNames = ["preview-1"];
const managedKeys = [
  "HOST",
  "APP_ORIGIN",
  "DATA_DIRECTORY",
  "GOOGLE_CLIENT_ID",
  "ADMIN_EMAILS",
];
const labelNames = (pull) =>
  pull.labels.map((label) => (typeof label === "string" ? label : label.name));
export const isStage = (pull) =>
  pull.head.ref === "stage" && pull.base.ref === "main";

export function allocateSlots(pulls, repository) {
  const eligible = pulls.filter(
    (pull) =>
      pull.state === "open" &&
      pull.head.repo?.full_name === repository &&
      !isStage(pull),
  );
  eligible.sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number,
  );
  const slots = new Map();
  for (const pull of eligible) {
    const labels = labelNames(pull).filter((name) => name === "preview-slot-1");
    if (labels.length > 1)
      throw new Error(`PR #${pull.number} has multiple preview slots.`);
    if (!labels.length) continue;
    const slot = `preview-${labels[0].at(-1)}`;
    if (slots.has(slot))
      throw new Error(`Duplicate owner for ${slot}; refusing to deploy.`);
    slots.set(slot, pull);
  }
  const queued = [];
  for (const pull of eligible) {
    if ([...slots.values()].some((owner) => owner.number === pull.number))
      continue;
    const free = slotNames.find((slot) => !slots.has(slot));
    if (free) slots.set(free, pull);
    else queued.push(pull);
  }
  return { slots, queued };
}

export function configuration(env) {
  if (!/^[a-zA-Z0-9_-]+$/.test(env.HOSTINGER_USERNAME || ""))
    throw new Error("Set HOSTINGER_USERNAME.");
  const variables = [
    "HOSTINGER_DOMAIN",
    "HOSTINGER_STAGE_DOMAIN",
    "HOSTINGER_PREVIEW_1_DOMAIN",
  ];
  const domains = variables.map((key) => {
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(env[key] || ""))
      throw new Error(`Set ${key} to its own website hostname.`);
    return env[key].toLowerCase();
  });
  if (new Set(domains).size !== 3)
    throw new Error("All three Hostinger websites must be different.");
  return Object.fromEntries(
    ["production", "stage", ...slotNames].map((name, i) => [name, domains[i]]),
  );
}

export function runtimeVariables(env, domain, directory) {
  const root = `/home/${env.HOSTINGER_USERNAME}/townseeker-data/`;
  if (
    !directory.startsWith(root) ||
    !/^[a-zA-Z0-9_/-]+$/.test(directory) ||
    directory.includes("..")
  )
    throw new Error("Unsafe data directory.");
  return [
    { key: "HOST", value: "0.0.0.0" },
    { key: "APP_ORIGIN", value: `https://${domain}` },
    { key: "DATA_DIRECTORY", value: directory },
    ...["GOOGLE_CLIENT_ID", "ADMIN_EMAILS"]
      .filter((key) => env[key]?.trim())
      .map((key) => ({ key, value: env[key].trim() })),
  ];
}

export function checkGate(runs, sha, branch, pr) {
  const latest = runs
    .filter(
      (run) =>
        run.head_sha === sha &&
        ["push", "pull_request", "workflow_dispatch"].includes(run.event) &&
        (pr
          ? run.event === "pull_request" &&
            run.pull_requests?.some((item) => item.number === pr)
          : run.head_branch === branch && run.event !== "pull_request"),
    )
    .sort((a, b) => b.id - a.id)[0];
  return latest?.status === "completed" && latest.conclusion === "success"
    ? latest
    : null;
}

export function deploymentComment(label, domain, state, sha) {
  const statuses = {
    waiting:
      "Waiting for successful checks on this revision. The website may still show an older deployment.",
    deploying:
      "Deployment in progress. The website is not verified for this revision yet.",
    ready: "Ready — deployment and live checks passed for this revision.",
    failed:
      "Deployment failed. The website is not verified for this revision; see the reconciliation workflow logs.",
    queued:
      "Waiting for an available preview slot. No website is assigned yet.",
    closed: "PR closed. This PR no longer has an active deployment assignment.",
  };
  if (!statuses[state]) throw new Error("Unknown deployment comment state.");
  return [
    "<!-- townseeker-deployment -->",
    "### TownSeeker deployment",
    "",
    `**Label:** \`${label}\``,
    `**Status:** ${statuses[state]}`,
    ...(domain ? [`**Website:** [${domain}](https://${domain}/)`] : []),
    ...(/^[a-f0-9]{40}$/.test(sha || "")
      ? [`**Revision:** \`${sha.slice(0, 12)}\``]
      : []),
  ].join("\n");
}

function command(binary, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${binary} exited ${code}.`)),
    );
  });
}

export async function reconcile(env = process.env, dependencies = {}) {
  const sites = configuration(env); // Validate every site before labels or hosting writes.
  if (
    !env.GH_TOKEN ||
    !env.HOSTINGER_API_TOKEN ||
    !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || "")
  )
    throw new Error("GitHub repository and deployment tokens are required.");
  const request = dependencies.fetch || fetch;
  const run = dependencies.command || command;
  const repository = env.GITHUB_REPOSITORY;
  const githubRoot = `https://api.github.com/repos/${repository}`;
  const api = async (root, token, endpoint, method = "GET", body) => {
    const response = await request(`${root}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new Error(`${method} ${endpoint}: HTTP ${response.status}`);
    if (response.status === 204) return null;
    return response.json();
  };
  const gh = (endpoint, method, body) =>
    api(githubRoot, env.GH_TOKEN, endpoint, method, body);
  const host = (domain, endpoint, method, body) =>
    api(
      `https://developers.hostinger.com/api/hosting/v1/accounts/${env.HOSTINGER_USERNAME}/websites/${domain}/nodejs`,
      env.HOSTINGER_API_TOKEN,
      endpoint,
      method,
      body,
    );
  const list = async (endpoint) => {
    const result = [];
    for (let page = 1; ; page++) {
      const rows = await gh(
        `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      result.push(...rows);
      if (rows.length < 100) return result;
    }
  };
  const pulls = await list("/pulls?state=open&sort=created&direction=asc");
  const plan = allocateSlots(pulls, repository);
  const comment = async (pull, label, domain, state, sha = pull.head.sha) => {
    const body = deploymentComment(label, domain, state, sha);
    const comments = await list(`/issues/${pull.number}/comments`);
    // Only update our workflow bot's marked comment; never overwrite a user's text.
    const existing = comments.find(
      (item) =>
        item.user?.login === "github-actions[bot]" &&
        item.user.type === "Bot" &&
        item.body?.startsWith("<!-- townseeker-deployment -->"),
    );
    if (existing?.body === body) return;
    if (existing)
      await gh(`/issues/comments/${existing.id}`, "PATCH", { body });
    else await gh(`/issues/${pull.number}/comments`, "POST", { body });
  };
  const report = async (name, state, sha) => {
    const recipients =
      name === "stage"
        ? pulls.filter(
            (pull) => pull.head.repo?.full_name === repository && isStage(pull),
          )
        : plan.slots.has(name)
          ? [plan.slots.get(name)]
          : [];
    for (const pull of recipients)
      await comment(
        pull,
        name === "stage" ? "Stage" : `preview-slot-${name.at(-1)}`,
        sites[name],
        state,
        sha ?? pull.head.sha,
      );
  };
  const source = async (branch, pull) => {
    if (pull) {
      const current = await gh(`/pulls/${pull.number}`);
      if (
        current.state !== "open" ||
        current.head.repo?.full_name !== repository ||
        isStage(current)
      )
        return null;
      return {
        sha: current.head.sha,
        branch: current.head.ref,
        pr: current.number,
      };
    }
    const ref = await gh(`/git/ref/heads/${branch}`);
    return { sha: ref.object.sha, branch, pr: null };
  };
  const checked = async (target) => {
    if (!/^[a-f0-9]{40}$/.test(target.sha))
      throw new Error("Invalid source SHA.");
    const runs = await gh(
      `/actions/workflows/deploy.yml/runs?head_sha=${target.sha}&per_page=100`,
    );
    const gate = checkGate(
      runs.workflow_runs,
      target.sha,
      target.branch,
      target.pr,
    );
    if (!gate) return false;
    const jobs = await gh(`/actions/runs/${gate.id}/jobs?per_page=100`);
    return ["verify", "lint / lint", "e2e / e2e"].every((name) =>
      jobs.jobs.some(
        (job) => job.name === name && job.conclusion === "success",
      ),
    );
  };
  const status = (id, state, url) =>
    gh(`/deployments/${id}/statuses`, "POST", {
      state,
      environment_url: url,
      auto_inactive: false,
    });
  const latest = async (name) =>
    (await gh(`/deployments?environment=${name}&per_page=1`))[0];
  const summary = async (message) => {
    console.log(message);
    if (env.GITHUB_STEP_SUMMARY)
      await appendFile(env.GITHUB_STEP_SUMMARY, `${message}\n`);
  };
  const smoke = async (domain, parked) => {
    const root = `https://${domain}`;
    const page = await request(root, {
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (
      page.status !== 200 ||
      !(await page.text()).includes(
        parked ? "TownSeeker preview unavailable" : "TownSeeker",
      )
    )
      throw new Error("Live page verification failed.");
    if (parked) return;
    for (const path of ["/admin.html", "/player.html", "/api/health"]) {
      const response = await request(root + path, {
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
      if (response.status !== 200)
        throw new Error(`Live verification failed for ${path}.`);
    }
    const response = await request(root + "/api/auth/session", {
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (response.status !== (env.GOOGLE_CLIENT_ID?.trim() ? 401 : 503))
      throw new Error("Unauthenticated session was not denied.");
    const config = await request(root + "/api/auth/config", {
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!env.GOOGLE_CLIENT_ID?.trim()) {
      if (config.status !== 503)
        throw new Error("Unconfigured authentication did not fail closed.");
    } else if (
      config.status !== 200 ||
      (await config.json()).clientId !== env.GOOGLE_CLIENT_ID.trim()
    )
      throw new Error("Google configuration verification failed.");
  };
  const deploy = async (name, target, kind, directory) => {
    const domain = sites[name];
    const url = `https://${domain}`;
    const runtime = runtimeVariables(env, domain, directory);
    const current = await host(domain, "/builds/settings/env");
    if (
      !Array.isArray(current) ||
      current.some(({ key }) => !managedKeys.includes(key))
    )
      throw new Error(
        `${name} has unmanaged runtime variables; refusing to erase them.`,
      );
    // Unknown masked OAuth/admin values cannot safely be reconstructed.
    if (
      current.some(
        ({ key }) =>
          ["GOOGLE_CLIENT_ID", "ADMIN_EMAILS"].includes(key) &&
          !env[key]?.trim(),
      )
    )
      throw new Error(
        `${name}: supply existing Google/admin settings as GitHub variables first.`,
      );
    const configHash = createHash("sha256")
      .update(JSON.stringify(runtime))
      .digest("hex");
    const previous = await latest(name);
    if (
      previous?.payload?.townseeker &&
      previous.sha === target.sha &&
      previous.payload.kind === kind &&
      previous.payload.pr === target.pr &&
      previous.payload.configHash === configHash
    ) {
      const statuses = await gh(
        `/deployments/${previous.id}/statuses?per_page=1`,
      );
      if (statuses[0]?.state === "success") {
        if (kind === "app") await report(name, "ready", target.sha);
        return previous;
      }
    }
    if (kind === "app") {
      const currentSource = target.pr
        ? await source(null, { number: target.pr })
        : await source(target.branch);
      if (!currentSource || currentSource.sha !== target.sha)
        throw new Error("Source changed; refusing obsolete deployment.");
    }
    // Fetch objects only. PR scripts, package hooks and dependencies never run here.
    await run("git", [
      "-c",
      "http.extraheader=",
      "fetch",
      "--no-tags",
      "--depth=1",
      `https://github.com/${repository}.git`,
      target.sha,
    ]);
    const record = await gh("/deployments", "POST", {
      ref: target.sha,
      environment: name,
      auto_merge: false,
      required_contexts: [],
      production_environment: name === "production",
      transient_environment: name.startsWith("preview-"),
      payload: {
        townseeker: true,
        kind,
        pr: target.pr,
        dataDirectory: directory,
        configHash,
      },
      description:
        kind === "park"
          ? "Preview slot unavailable"
          : `TownSeeker ${name}${target.pr ? ` PR #${target.pr}` : ""}`,
    });
    await status(record.id, "in_progress", url);
    try {
      if (kind === "app") await report(name, "deploying", target.sha);
      await host(domain, "/builds/settings/env", "PUT", { env_vars: runtime });
      const childEnv = {
        ...env,
        HOSTINGER_DOMAIN: domain,
        DEPLOY_SHA: target.sha,
        DEPLOY_ENVIRONMENT: name,
        DEPLOY_KIND: kind,
      };
      // Do not expose the GitHub token to even the trusted upload helper.
      delete childEnv.GH_TOKEN;
      await run("bash", ["deploy/deploy.sh"], childEnv);
      await smoke(domain, kind === "park");
      await status(record.id, "success", url);
      if (kind === "app") await report(name, "ready", target.sha);
      await summary(
        `- ${name}${target.pr ? ` (PR #${target.pr})` : ""}: ${url}${kind === "park" ? " — parked" : ""}`,
      );
      return record;
    } catch (error) {
      await status(record.id, "failure", url);
      throw error;
    }
  };
  const main = await source("main");
  const failures = [];
  const attempt = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
      await summary(`- ${label} failed: ${error.message}`);
      try {
        await report(label === "main" ? "production" : label, "failed");
      } catch (commentError) {
        failures.push(`${label} comment: ${commentError.message}`);
      }
    }
  };
  // Park released/reassigned slots BEFORE changing their labels or runtime data.
  for (const name of slotNames)
    await attempt(name, async () => {
      const old = await latest(name);
      const owner = plan.slots.get(name);
      if (old && !old.payload?.townseeker)
        throw new Error(
          "Unrecognized deployment history; refusing slot reuse.",
        );
      const parked =
        old?.payload?.kind === "park" &&
        (await gh(`/deployments/${old.id}/statuses?per_page=1`))[0]?.state ===
          "success";
      if (
        old &&
        !parked &&
        (old.payload.kind === "park" || old.payload.pr !== owner?.number)
      ) {
        await deploy(
          name,
          { ...main, pr: null },
          "park",
          `/home/${env.HOSTINGER_USERNAME}/townseeker-data/${name}/idle`,
        );
        await status(old.id, "inactive", `https://${sites[name]}`);
        const history = await list(`/deployments?environment=${name}`);
        for (const record of history) {
          if (
            record.id !== old.id &&
            record.payload?.townseeker &&
            record.payload.kind === "app"
          ) {
            await status(record.id, "inactive", `https://${sites[name]}`);
          }
        }
      }
    });
  if (failures.length) throw new Error(failures.join("\n"));
  for (const name of ["Stage", "Queued", "preview-slot-1"]) {
    const labels = await list("/labels");
    if (!labels.some((label) => label.name === name))
      await gh("/labels", "POST", {
        name,
        color: name === "Queued" ? "FBCA04" : "0969DA",
      });
  }
  const updateLabels = async (pull, desired) => {
    const names = labelNames(pull);
    for (const name of names.filter(
      (name) =>
        /^(Stage|Queued|preview-slot-[123])$/.test(name) &&
        !desired.includes(name),
    ))
      await gh(
        `/issues/${pull.number}/labels/${encodeURIComponent(name)}`,
        "DELETE",
      );
    const add = desired.filter((name) => !names.includes(name));
    if (add.length)
      await gh(`/issues/${pull.number}/labels`, "POST", { labels: add });
  };
  for (const pull of pulls) {
    if (pull.head.repo?.full_name !== repository) continue;
    const slot = [...plan.slots].find(
      ([, owner]) => owner.number === pull.number,
    )?.[0];
    await updateLabels(
      pull,
      isStage(pull)
        ? ["Stage"]
        : slot
          ? [`preview-slot-${slot.at(-1)}`]
          : ["Queued"],
    );
  }
  if (env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
    if (event.pull_request?.number) {
      const closed = await gh(`/pulls/${event.pull_request.number}`);
      if (
        closed.state === "closed" &&
        closed.head.repo?.full_name === repository
      ) {
        await updateLabels(closed, []);
        await comment(closed, "Closed", null, "closed");
      }
    }
  }
  for (const branch of ["main", "stage"])
    await attempt(branch, async () => {
      const target = await source(branch);
      if (await checked(target))
        await deploy(
          branch === "main" ? "production" : "stage",
          target,
          "app",
          `/home/${env.HOSTINGER_USERNAME}/townseeker-data/${branch === "main" ? "production" : "stage"}`,
        );
      else {
        await summary(
          `- ${branch}: waiting for successful checks on ${target.sha.slice(0, 12)}.`,
        );
        await report(
          branch === "main" ? "production" : "stage",
          "waiting",
          target.sha,
        );
      }
    });
  for (const [name, pull] of plan.slots)
    await attempt(name, async () => {
      const target = await source(null, pull);
      if (!target || !(await checked(target))) {
        await summary(
          `- PR #${pull.number}: waiting for current successful checks.`,
        );
        if (target) await report(name, "waiting", target.sha);
        return;
      }
      const previous = await latest(name);
      const directory =
        previous?.payload?.pr === pull.number && previous.payload.kind === "app"
          ? previous.payload.dataDirectory
          : `/home/${env.HOSTINGER_USERNAME}/townseeker-data/${name}/pr-${pull.number}-${randomUUID()}`;
      await deploy(name, target, "app", directory);
    });
  for (const pull of plan.queued) {
    await summary(`- PR #${pull.number}: queued for a preview slot.`);
    await comment(pull, "Queued", null, "queued");
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  reconcile().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
