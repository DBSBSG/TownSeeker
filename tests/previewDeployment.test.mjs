import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateSlots,
  checkGate,
  configuration,
  isStage,
  runtimeVariables,
  reconcile,
  deploymentComment,
} from "../deploy/preview-slots.mjs";

const repository = "DBSBSG/TownSeeker";
const sha = "a".repeat(40);
const pull = (number, labels = [], extra = {}) => ({
  number,
  state: "open",
  labels: labels.map((name) => ({ name })),
  created_at: `2026-11-${String(number).padStart(2, "0")}T00:00:00Z`,
  head: { ref: `feature/${number}`, sha, repo: { full_name: repository } },
  base: { ref: "stage" },
  ...extra,
});
const env = {
  HOSTINGER_USERNAME: "u123",
  HOSTINGER_DOMAIN: "main.example.com",
  HOSTINGER_STAGE_DOMAIN: "stage.example.com",
  HOSTINGER_PREVIEW_1_DOMAIN: "pr1.example.com",
  HOSTINGER_PREVIEW_2_DOMAIN: "pr2.example.com",
  HOSTINGER_PREVIEW_3_DOMAIN: "pr3.example.com",
  GH_TOKEN: "github-fixture",
  HOSTINGER_API_TOKEN: "host-fixture",
  GITHUB_REPOSITORY: repository,
};

test("stage PR has a dedicated site, never a preview slot", () => {
  const stage = pull(1, ["preview-slot-1"], {
    head: { ref: "stage", sha, repo: { full_name: repository } },
    base: { ref: "main" },
  });
  const plan = allocateSlots(
    [stage, pull(2), pull(3), pull(4), pull(5)],
    repository,
  );
  assert(isStage(stage));
  assert.deepEqual(
    [...plan.slots.values()].map((p) => p.number),
    [2, 3, 4],
  );
  assert.deepEqual(
    plan.queued.map((p) => p.number),
    [5],
  );
});
test("preserves assigned slots, allocates oldest waiting PR first, and ignores forks/closed PRs", () => {
  const rows = [
    pull(7),
    pull(5),
    pull(3, ["preview-slot-2"]),
    pull(1, [], { state: "closed" }),
    pull(2, [], {
      head: { ref: "fork", sha, repo: { full_name: "outsider/repo" } },
    }),
    pull(6),
  ];
  const plan = allocateSlots(rows, repository);
  assert.equal(plan.slots.get("preview-2").number, 3);
  assert.equal(plan.slots.get("preview-1").number, 5);
  assert.equal(plan.slots.get("preview-3").number, 6);
  assert.equal(plan.queued[0].number, 7);
});
test("fails closed on duplicate or multiple slot labels", () => {
  assert.throws(
    () =>
      allocateSlots(
        [pull(1, ["preview-slot-1"]), pull(2, ["preview-slot-1"])],
        repository,
      ),
    /Duplicate/,
  );
  assert.throws(
    () =>
      allocateSlots(
        [pull(1, ["preview-slot-1", "preview-slot-2"])],
        repository,
      ),
    /multiple/,
  );
});
test("requires all five distinct domains before any writes", async () => {
  assert.throws(
    () => configuration({ ...env, HOSTINGER_STAGE_DOMAIN: "" }),
    /HOSTINGER_STAGE_DOMAIN/,
  );
  assert.throws(
    () =>
      configuration({ ...env, HOSTINGER_STAGE_DOMAIN: env.HOSTINGER_DOMAIN }),
    /different/,
  );
  assert.throws(
    () =>
      configuration({
        ...env,
        HOSTINGER_STAGE_DOMAIN: "https://stage.example.com",
      }),
    /hostname/,
  );
  let calls = 0;
  await assert.rejects(
    reconcile(
      { ...env, HOSTINGER_PREVIEW_3_DOMAIN: "" },
      {
        fetch: () => {
          calls++;
        },
      },
    ),
    /HOSTINGER_PREVIEW_3_DOMAIN/,
  );
  assert.equal(calls, 0);
});
test("data directories stay private; OAuth/admin variables can be omitted", () => {
  const runtime = runtimeVariables(
    env,
    env.HOSTINGER_DOMAIN,
    "/home/u123/townseeker-data/production",
  );
  assert.deepEqual(
    runtime.map((v) => v.key),
    ["HOST", "APP_ORIGIN", "DATA_DIRECTORY"],
  );
  assert.throws(
    () =>
      runtimeVariables(
        env,
        env.HOSTINGER_DOMAIN,
        "/home/u123/domains/main/public_html",
      ),
    /Unsafe/,
  );
  assert.throws(
    () =>
      runtimeVariables(
        env,
        env.HOSTINGER_DOMAIN,
        "/home/u123/townseeker-data/../production",
      ),
    /Unsafe/,
  );
});
test("only the latest successful checks for the exact source and PR can deploy", () => {
  const run = {
    id: 1,
    head_sha: sha,
    head_branch: "stage",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  assert.equal(checkGate([run], sha, "stage", null), run);
  assert.equal(
    checkGate(
      [run, { ...run, id: 2, status: "in_progress", conclusion: null }],
      sha,
      "stage",
      null,
    ),
    null,
  );
  assert.equal(
    checkGate([{ ...run, head_sha: "b".repeat(40) }], sha, "stage", null),
    null,
  );
  assert.equal(
    checkGate([{ ...run, event: "workflow_run" }], sha, "stage", null),
    null,
  );
  assert.equal(
    checkGate(
      [{ ...run, event: "pull_request", pull_requests: [{ number: 3 }] }],
      sha,
      "feature",
      4,
    ),
    null,
  );
});

function fixture({
  previous,
  unmanaged = false,
  missingJob = false,
  closed = false,
  advance = false,
  failedPark = false,
  branchRuns = false,
  initialComments = [],
  failDeploy = false,
  pulls = [pull(1)],
} = {}) {
  const calls = [];
  const commands = [];
  const comments = structuredClone(initialComments);
  const deployments = previous
    ? [{ ...previous, environment: "preview-1" }]
    : [];
  const statuses = new Map();
  let sourceReads = 0;
  const response = (value, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () =>
      typeof value === "string" ? value : JSON.stringify(value),
  });
  const fakeFetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });
    if (url.startsWith("https://api.github.com")) {
      const path = new URL(url).pathname.replace(`/repos/${repository}`, "");
      if (path === "/pulls") return response(pulls);
      if (/^\/pulls\/\d+$/.test(path)) {
        sourceReads++;
        const number = Number(path.split("/")[2]);
        return response(
          pull(number, [], {
            state: closed ? "closed" : "open",
            head: {
              ref: `feature/${number}`,
              sha: advance && sourceReads > 1 ? "b".repeat(40) : sha,
              repo: { full_name: repository },
            },
          }),
        );
      }
      if (path.startsWith("/git/ref/heads/"))
        return response({ object: { sha } });
      if (path === "/labels")
        return response(
          [
            "Stage",
            "Queued",
            "preview-slot-1",
            "preview-slot-2",
            "preview-slot-3",
          ].map((name) => ({ name })),
        );
      if (/^\/issues\/\d+\/comments$/.test(path)) {
        const number = Number(path.split("/")[2]);
        if (method === "GET")
          return response(
            comments.filter((item) => item.issue_number === number),
          );
        const item = {
          id: 1000 + comments.length,
          issue_number: number,
          body: body.body,
          user: { login: "github-actions[bot]", type: "Bot" },
        };
        comments.push(item);
        return response(item);
      }
      if (/^\/issues\/comments\/\d+$/.test(path) && method === "PATCH") {
        const item = comments.find(
          (item) => item.id === Number(path.split("/")[3]),
        );
        assert(item, "Cannot update an unknown comment");
        item.body = body.body;
        return response(item);
      }
      if (path.startsWith("/issues/")) return response({});
      if (path === "/actions/workflows/deploy.yml/runs")
        return response({
          workflow_runs: [
            ...(branchRuns
              ? ["main", "stage"].map((branch, i) => ({
                  id: 20 + i,
                  head_sha: sha,
                  head_branch: branch,
                  event: "push",
                  status: "completed",
                  conclusion: "success",
                }))
              : []),
            ...pulls.map((p) => ({
              id: 10 + p.number,
              head_sha: sha,
              head_branch: p.head.ref,
              event: "pull_request",
              pull_requests: [{ number: p.number }],
              status: "completed",
              conclusion: "success",
            })),
          ],
        });
      if (/^\/actions\/runs\/\d+\/jobs$/.test(path))
        return response({
          jobs: (missingJob
            ? ["verify"]
            : ["verify", "lint / lint", "e2e / e2e"]
          ).map((name) => ({ name, conclusion: "success" })),
        });
      if (path === "/deployments" && method === "GET")
        return response(
          deployments
            .filter(
              (d) =>
                d.environment === new URL(url).searchParams.get("environment"),
            )
            .slice(new URL(url).searchParams.get("per_page") === "1" ? -1 : 0)
            .reverse(),
        );
      if (path === "/deployments" && method === "POST") {
        const record = { ...body, sha: body.ref, id: deployments.length + 100 };
        deployments.push(record);
        return response(record);
      }
      if (/\/deployments\/\d+\/statuses$/.test(path)) {
        const id = Number(path.split("/")[2]);
        if (method === "POST") {
          statuses.set(id, body.state);
          return response({});
        }
        return response([
          { state: statuses.get(id) || (failedPark ? "failure" : "success") },
        ]);
      }
      throw new Error(`Unexpected GitHub request ${method} ${url}`);
    }
    if (url.startsWith("https://developers.hostinger.com"))
      return response(
        method === "GET"
          ? unmanaged
            ? [{ key: "UNKNOWN_SECRET", value: "********" }]
            : []
          : {},
      );
    if (
      Object.values(configuration(env)).some(
        (domain) => url === `https://${domain}`,
      )
    )
      return response(
        commands.at(-1)?.env?.DEPLOY_KIND === "park"
          ? "TownSeeker preview unavailable"
          : "TownSeeker",
      );
    if (url.endsWith("/api/auth/session")) return response({}, 503);
    if (url.endsWith("/api/auth/config")) return response({}, 503);
    return response("TownSeeker");
  };
  return {
    calls,
    commands,
    deployments,
    statuses,
    comments,
    dependencies: {
      fetch: fakeFetch,
      command: async (binary, args, childEnv) => {
        commands.push({ binary, args, env: childEnv });
        if (failDeploy && binary === "bash")
          throw new Error("Mock build failure");
      },
    },
  };
}

test("publishes a preview URL, without executing PR code or passing GitHub token to uploader", async () => {
  const f = fixture();
  await reconcile(env, f.dependencies);
  const uploader = f.commands.find((c) => c.binary === "bash");
  assert.equal(uploader.env.DEPLOY_ENVIRONMENT, "preview-1");
  assert.equal(uploader.env.GH_TOKEN, undefined);
  assert.match(f.deployments[0].payload.dataDirectory, /\/preview-1\/pr-1-/);
  assert(
    f.calls.some(
      (c) =>
        c.method === "POST" &&
        c.body?.state === "success" &&
        c.body.environment_url === "https://pr1.example.com",
    ),
  );
  assert(
    !f.commands.some((c) => c.args.includes("checkout") || c.binary === "pnpm"),
  );
});
test("all five websites have separate releases and data; identical successful releases are not redeployed", async () => {
  const f = fixture({
    branchRuns: true,
    pulls: [pull(1), pull(2), pull(3), pull(4)],
  });
  await reconcile(env, f.dependencies);
  assert.deepEqual(
    f.commands
      .filter((c) => c.binary === "bash")
      .map((c) => c.env.DEPLOY_ENVIRONMENT),
    ["production", "stage", "preview-1", "preview-2", "preview-3"],
  );
  assert.equal(
    new Set(f.deployments.map((d) => d.payload.dataDirectory)).size,
    5,
  );
  assert(
    f.calls.some(
      (c) =>
        c.url.endsWith("/issues/4/labels") && c.body.labels.includes("Queued"),
    ),
  );
  f.commands.length = 0;
  await reconcile(env, f.dependencies);
  assert.equal(f.commands.length, 0);
});
test("parks an old PR before reusing its slot and never reuses the old data directory", async () => {
  const old = {
    id: 3,
    sha,
    payload: {
      townseeker: true,
      kind: "app",
      pr: 9,
      dataDirectory: "/home/u123/townseeker-data/preview-1/pr-9-old",
    },
  };
  const f = fixture({ previous: old });
  await reconcile(env, f.dependencies);
  assert.deepEqual(
    f.commands.filter((c) => c.binary === "bash").map((c) => c.env.DEPLOY_KIND),
    ["park", "app"],
  );
  assert.equal(f.statuses.get(3), "inactive");
  assert.notEqual(
    f.deployments.at(-1).payload.dataDirectory,
    old.payload.dataDirectory,
  );
});
test("refuses to overwrite unknown masked runtime settings", async () => {
  const f = fixture({ unmanaged: true });
  await assert.rejects(reconcile(env, f.dependencies), /unmanaged/);
  assert.equal(f.commands.length, 0);
  assert(!f.calls.some((c) => c.method === "PUT"));
});
test("an interrupted or failed parking deployment must be retried before slot reuse", async () => {
  const f = fixture({
    previous: {
      id: 3,
      sha,
      payload: { townseeker: true, kind: "park", pr: null },
    },
    failedPark: true,
  });
  await reconcile(env, f.dependencies);
  assert.deepEqual(
    f.commands.filter((c) => c.binary === "bash").map((c) => c.env.DEPLOY_KIND),
    ["park", "app"],
  );
});
test("does not deploy when required jobs are missing or a PR closed", async () => {
  for (const options of [{ missingJob: true }, { closed: true }]) {
    const f = fixture(options);
    await reconcile(env, f.dependencies);
    assert.equal(f.commands.length, 0);
  }
});
test("a changed PR head cannot reach a hosting write", async () => {
  const f = fixture({ advance: true });
  await assert.rejects(reconcile(env, f.dependencies), /obsolete/);
  assert(!f.calls.some((c) => c.method === "PUT"));
});

test("preview comments show the assigned hostname, label and verified revision", async () => {
  const f = fixture();
  await reconcile(env, f.dependencies);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /Label:\*\* `preview-slot-1`/);
  assert.match(
    f.comments[0].body,
    /\[pr1.example.com\]\(https:\/\/pr1.example.com\/\)/,
  );
  assert.match(f.comments[0].body, /Ready — deployment and live checks passed/);
  assert.match(f.comments[0].body, new RegExp(sha.slice(0, 12)));
  assert(
    f.calls.some((call) => call.body?.body?.includes("Deployment in progress")),
  );
});

test("Stage comments use only the dedicated stage hostname", async () => {
  const stage = pull(1, ["Stage", "bug"], {
    head: { ref: "stage", sha, repo: { full_name: repository } },
    base: { ref: "main" },
  });
  const f = fixture({ pulls: [stage], branchRuns: true });
  await reconcile(env, f.dependencies);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /Label:\*\* `Stage`/);
  assert.match(f.comments[0].body, /https:\/\/stage.example.com\//);
  assert.doesNotMatch(
    f.comments[0].body,
    /pr1.example.com|main.example.com|`bug`/,
  );
});

test("updates one bot comment without touching human comments or adding duplicates", async () => {
  const human = {
    id: 7,
    issue_number: 1,
    user: { login: "Cody0921", type: "User" },
    body: "<!-- townseeker-deployment -->\nKeep this human comment.",
  };
  const f = fixture({ initialComments: [human] });
  await reconcile(env, f.dependencies);
  assert.equal(f.comments.length, 2);
  assert.deepEqual(f.comments[0], human);
  const writes = () =>
    f.calls.filter(
      (call) =>
        ["POST", "PATCH"].includes(call.method) && /\/comments/.test(call.url),
    ).length;
  const before = writes();
  await reconcile(env, f.dependencies);
  assert.equal(f.comments.length, 2);
  assert.equal(
    writes(),
    before,
    "Identical ready comments need no additional writes",
  );
});

test("waiting and queued comments never claim the current revision is deployed", async () => {
  const f = fixture({
    missingJob: true,
    pulls: [pull(1), pull(2), pull(3), pull(4)],
  });
  await reconcile(env, f.dependencies);
  assert.match(
    f.comments.find((c) => c.issue_number === 1).body,
    /Waiting for successful checks/,
  );
  const queued = f.comments.find((c) => c.issue_number === 4).body;
  assert.match(queued, /Label:\*\* `Queued`/);
  assert.doesNotMatch(queued, /\*\*Website:\*\*|Ready —/);
  assert(f.comments.every((c) => !c.body.includes("Ready —")));
});

test("a failed deployment updates the comment to failed without exposing the error", async () => {
  const f = fixture({ failDeploy: true });
  await assert.rejects(reconcile(env, f.dependencies), /Mock build failure/);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /Deployment failed/);
  assert.doesNotMatch(f.comments[0].body, /Ready —|Mock build failure/);
});

test("closed comments remove active deployment links", () => {
  const body = deploymentComment("Closed", null, "closed", sha);
  assert.match(body, /no longer has an active deployment assignment/);
  assert.doesNotMatch(body, /\*\*Website:\*\*/);
});

test("a queued PR's existing comment gains its website when a slot becomes available", async () => {
  const pulls = [pull(1), pull(2), pull(3), pull(4)];
  const f = fixture({ pulls });
  await reconcile(env, f.dependencies);
  const queued = f.comments.find((item) => item.issue_number === 4);
  assert.match(queued.body, /No website is assigned yet/);
  const id = queued.id;
  pulls.shift();
  await reconcile(env, f.dependencies);
  const assigned = f.comments.filter((item) => item.issue_number === 4);
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].id, id);
  assert.match(assigned[0].body, /https:\/\/pr3.example.com\//);
  assert.match(assigned[0].body, /Ready —/);
  assert.doesNotMatch(assigned[0].body, /`Queued`/);
});
