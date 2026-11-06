import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentResult, AgentRunner, AgentTask } from "../../src/arena/agent";
import { Arena, type ArenaLanes } from "../../src/arena/arena";
import type { LaneDiff } from "../../src/arena/diff";
import type { UpResult } from "../../src/driver";
import type { LaneRecord } from "../../src/manager";
import { portsForSlot } from "../../src/plan";
import type { OptionPair } from "../../src/transform";

/** In-memory lanes: records what the Arena asks for. */
class FakeLanes implements ArenaLanes {
  constructor(private readonly root = "/lanes") {}
  lanes: LaneRecord[] = [];
  calls: string[] = [];
  failStart = new Set<string>();
  /** Lanes reported as running; everything else is stopped. */
  running = new Set<string>();
  async snapshot() {
    return this.lanes.map((lane) => ({ ...lane, state: this.running.has(lane.name) ? "running" : "stopped" }));
  }
  async stop(name: string) {
    this.calls.push(`stop ${name}`);
    this.running.delete(name);
  }
  sql: Record<string, string> = {};
  list() {
    return this.lanes;
  }
  async create(request: { name?: string; pair?: OptionPair; arena?: boolean }) {
    const slot = this.lanes.length + 1;
    const lane: LaneRecord = {
      name: request.name ?? `lane${slot}`,
      projectName: `${request.name}-lane`,
      slot,
      ports: portsForSlot(slot),
      dir: `${this.root}/${request.name}`,
      pair: request.pair ?? { a: "A", b: "B" },
      createdAt: "now",
      ...(request.arena ? { arena: true as const } : {}),
    };
    this.lanes.push(lane);
    this.calls.push(`create ${lane.name} ${lane.pair.a}/${lane.pair.b}${request.arena ? " arena" : ""}`);
    return lane;
  }
  async start(name: string): Promise<UpResult> {
    this.calls.push(`start ${name}`);
    if (!this.failStart.has(name)) this.running.add(name);
    return this.failStart.has(name)
      ? { ok: false, failures: [{ name: "vote", message: "port is already allocated" }] }
      : { ok: true, failures: [] };
  }
  async destroy(name: string) {
    this.calls.push(`destroy ${name}`);
    this.lanes = this.lanes.filter((lane) => lane.name !== name);
  }
  async restart(name: string, service: string) {
    this.calls.push(`restart ${name} ${service}`);
  }
  async waitForBuilds(name: string, services: string[]) {
    this.calls.push(`waitForBuilds ${name} ${services.join(",")}`);
  }
  async containerAction(name: string, service: string, verb: string) {
    this.calls.push(`${verb}-container ${name} ${service}`);
  }
  async restartCount() {
    return 0;
  }
  async runSql(name: string, query: string) {
    const stdout = this.sql[`${name} ${query}`];
    return { ok: stdout !== undefined, stdout: stdout ?? "", stderr: stdout === undefined ? "no table" : "" };
  }
}

/** Scripted agents: each model "finishes" with a given cost. */
class FakeAgents implements AgentRunner {
  tasks: AgentTask[] = [];
  results: Record<string, Partial<AgentResult>> = {};
  async run(task: AgentTask): Promise<AgentResult> {
    this.tasks.push(task);
    return { outcome: "finished", summary: "done", costUsd: 0.1, durationMs: 60_000, turns: 5, deniedTools: [], ...this.results[task.model] };
  }
}

const noChange: LaneDiff = { files: [], patch: "", added: 0, removed: 0 };
const resultChange: LaneDiff = {
  files: [{ path: "result/server.js", change: "modified", added: 4, removed: 1 }],
  patch: "--- a/result/server.js\n+++ b/result/server.js\n",
  added: 4,
  removed: 1,
};

let base: string;
let lanes: FakeLanes;
let agents: FakeAgents;
/** What each lane's live app answers, by lane name and path. */
let live: Record<string, Record<string, { status: number; body: string }>>;
let diffs: Record<string, LaneDiff>;

/** Time only moves when a check waits or retries, so races with long waits run instantly. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function makeArena() {
  return new Arena({
    clock: fakeClock(),
    baseDir: base,
    lanes,
    agent: agents,
    http: async (lane, request) => live[lane.name]?.[request.path] ?? { status: 404, body: "" },
    diff: async (_base, laneDir) => diffs[laneDir] ?? noChange,
    prepareLane: () => undefined,
    checkTiming: { deadlineMs: 0, retryMs: 1 },
  });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "arena-base-"));
  lanes = new FakeLanes();
  agents = new FakeAgents();
  live = {};
  diffs = {};
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const healthy = (options: string) => ({
  "/api/vote/healthz": { status: 200, body: `{"status":"ok","options":${options}}` },
  "/api/vote/": { status: 200, body: '<button value="a"></button><button value="b"></button>' },
});

describe("Arena race", () => {
  test("three models race in their own lanes and are ranked by live checks, then by cost", async () => {
    live = {
      haiku: { "/api/vote/": healthy("[]")["/api/vote/"] },
      sonnet: healthy('["Tabs","Spaces"]'),
      opus: healthy('["Tabs","Spaces"]'),
    };
    agents.results = { "claude-sonnet-5-5": { costUsd: 0.3 }, "claude-opus-5-5": { costUsd: 0.9 } };
    const { finished } = makeArena().start({ taskId: "vote-healthz" });
    const run = await finished;

    expect(lanes.calls.filter((c) => c.startsWith("create"))).toEqual([
      "create haiku Tabs/Spaces arena",
      "create sonnet Tabs/Spaces arena",
      "create opus Tabs/Spaces arena",
      "create control Tabs/Spaces arena",
    ]);
    expect(agents.tasks.map((t) => [t.model, t.laneDir])).toEqual([
      ["claude-haiku-5-5", "/lanes/haiku"],
      ["claude-sonnet-5-5", "/lanes/sonnet"],
      ["claude-opus-5-5", "/lanes/opus"],
    ]);
    expect(agents.tasks[0].budgetUsd).toBe(1);
    expect(agents.tasks[0].prompt).toContain("GET /api/vote/healthz answers ok with this lane's options");

    const board = run.contestants.map((c) => [c.model, c.status, c.rank, c.checks?.filter((k) => k.passed).length]);
    expect(board).toEqual([
      ["haiku", "failed", 3, 1],
      ["sonnet", "passed", 1, 2],
      ["opus", "passed", 2, 2],
    ]);
    expect(run.finishedAt).toBeDefined();
  });

  test("only the services whose code an agent changed are restarted before checking", async () => {
    diffs = { "/lanes/opus": resultChange };
    await makeArena().start({ taskId: "vote-healthz" }).finished;
    expect(lanes.calls.filter((c) => c.startsWith("restart"))).toEqual(["restart opus result"]);
  });

  test("a new race replaces the previous race's lanes and never touches regular lanes", async () => {
    await lanes.create({ name: "alpha" });
    await lanes.create({ name: "haiku", arena: true });
    lanes.calls = [];
    await makeArena().start({ taskId: "vote-healthz" }).finished;
    expect(lanes.calls.filter((c) => c.startsWith("destroy"))).toEqual(["destroy haiku"]);
    expect(lanes.list().map((l) => l.name)).toEqual(["alpha", "haiku", "sonnet", "opus", "control"]);
  });

  test("a lane that does not boot is 'lane failed' and its agent never runs, so nothing is spent", async () => {
    lanes.failStart.add("sonnet");
    const run = await makeArena().start({ taskId: "vote-healthz" }).finished;
    const sonnet = run.contestants.find((c) => c.model === "sonnet");
    expect(sonnet?.status).toBe("lane_failed");
    expect(sonnet?.error).toContain("port is already allocated");
    expect(agents.tasks.map((t) => t.model)).not.toContain("claude-sonnet-5-5");
    expect(sonnet?.rank).toBe(3);
  });

  test("an agent that hit its budget or crashed is labelled so when its checks fail", async () => {
    agents.results = {
      "claude-haiku-5-5": { outcome: "over_budget", summary: "Reached maximum budget ($1)" },
      "claude-sonnet-5-5": { outcome: "error", summary: "boom" },
    };
    const run = await makeArena().start({ taskId: "vote-healthz" }).finished;
    expect(run.contestants.map((c) => c.status)).toEqual(["over_budget", "agent_error", "failed"]);
  });

  test("a free-text race has no checks: every finished contestant is 'unverified'", async () => {
    const run = await makeArena().start({ freeText: "Make the vote page purple" }).finished;
    expect(run.task).toMatchObject({ id: "free-text", unverified: true, request: "Make the vote page purple" });
    expect(run.contestants.map((c) => c.status)).toEqual(["unverified", "unverified", "unverified"]);
  });
});

describe("Arena runs on disk, and applying a winner", () => {
  test("a finished race is saved with each contestant's patch, and can be read back later", async () => {
    diffs = { "/lanes/opus": resultChange };
    const arena = makeArena();
    const run = await arena.start({ taskId: "vote-healthz" }).finished;
    const dir = join(base, ".arena", "runs", run.id);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).id).toBe(run.id);
    expect(readFileSync(join(dir, "opus.patch"), "utf8")).toContain("+++ b/result/server.js");
    expect(makeArena().latest()?.id).toBe(run.id);
    expect(arena.patch(run.id, "opus")).toContain("+++ b/result/server.js");
  });

  test("applying a passing contestant writes its change into the base, with backups", async () => {
    const laneRoot = join(base, ".lanes");
    lanes = new FakeLanes(laneRoot);
    mkdirSync(join(base, "result"), { recursive: true });
    writeFileSync(join(base, "result", "server.js"), "old\n");
    mkdirSync(join(laneRoot, "sonnet", "result"), { recursive: true });
    writeFileSync(join(laneRoot, "sonnet", "result", "server.js"), "new\n");
    live = { sonnet: healthy('["Tabs","Spaces"]') };
    const arena = new Arena({
      clock: fakeClock(),
      baseDir: base,
      lanes,
      agent: agents,
      http: async (lane, request) => live[lane.name]?.[request.path] ?? { status: 404, body: "" },
      prepareLane: () => undefined,
      checkTiming: { deadlineMs: 0, retryMs: 1 },
    });
    const run = await arena.start({ taskId: "vote-healthz" }).finished;
    const written = await arena.apply(run.id, "sonnet");
    expect(written).toEqual(["result/server.js"]);
    expect(readFileSync(join(base, "result", "server.js"), "utf8")).toBe("new\n");
    expect(readFileSync(join(base, ".arena", "backups", run.id, "sonnet", "result", "server.js"), "utf8")).toBe("old\n");
  });

  test("a contestant that failed its checks cannot be applied", async () => {
    const arena = makeArena();
    const run = await arena.start({ taskId: "vote-healthz" }).finished;
    await expect(arena.apply(run.id, "haiku")).rejects.toThrow(/did not pass/);
    expect(existsSync(join(base, ".arena", "backups"))).toBe(false);
  });
});

describe("Arena makes room: regular lanes pause for a race", () => {
  test("running regular lanes are stopped before the race and started again after; race lanes are set aside", async () => {
    await lanes.create({ name: "alpha" });
    await lanes.create({ name: "beta" });
    await lanes.create({ name: "gamma" });
    lanes.running = new Set(["alpha", "beta"]);
    lanes.calls = [];
    const run = await makeArena().start({ taskId: "vote-healthz" }).finished;
    const order = lanes.calls.filter((c) => /^(stop|start|create)/.test(c)).map((c) => c.replace(/ Tabs\/Spaces arena$/, ""));
    expect(order.slice(0, 2)).toEqual(["stop alpha", "stop beta"]);
    expect(order.slice(-6)).toEqual(["stop haiku", "stop sonnet", "stop opus", "stop control", "start alpha", "start beta"]);
    expect(order).not.toContain("start gamma");
    expect(run.paused).toEqual(["alpha", "beta"]);
    expect(lanes.list().map((l) => l.name)).toContain("opus");
  });

  test("a race lane can be started again afterwards to try its version live", async () => {
    const arena = makeArena();
    await arena.start({ taskId: "vote-healthz" }).finished;
    lanes.calls = [];
    await arena.startLane("sonnet");
    expect(lanes.calls).toEqual(["start sonnet"]);
  });
});

describe("Arena proves its checks and handles compiled services", () => {
  test("a preset race first runs its checks on an untouched control lane, where no agent works", async () => {
    live = { control: { "/api/vote/": healthy("[]")["/api/vote/"] } };
    const run = await makeArena().start({ taskId: "vote-healthz" }).finished;
    expect(agents.tasks.map((t) => t.laneDir)).not.toContain("/lanes/control");
    expect(run.baseline).toMatchObject({ passed: 1, total: 2 });
    expect(run.baseline?.checks?.find((k) => !k.passed)?.id).toBe("healthz");
    expect(run.contestants.map((c) => c.model)).toEqual(["haiku", "sonnet", "opus"]);
  });

  test("when the original code already passes every check, the race says the checks prove nothing", async () => {
    live = { control: healthy('["Tabs","Spaces"]') };
    const run = await makeArena().start({ taskId: "vote-healthz" }).finished;
    expect(run.baseline).toMatchObject({ passed: 2, total: 2 });
    expect(run.notes?.join(" ")).toContain("original code already passes");
  });

  test("a free-text race has nothing to prove, so it boots no control lane", async () => {
    await makeArena().start({ freeText: "Make the vote page purple" }).finished;
    expect(lanes.calls.some((c) => c.includes("control"))).toBe(false);
  });

  test("a contestant waits for Tilt to rebuild the services it changed before restarting and checking them", async () => {
    diffs = { "/lanes/opus": resultChange };
    await makeArena().start({ taskId: "vote-healthz" }).finished;
    const opus = lanes.calls.filter((c) => c.includes("opus") && /^(waitForBuilds|restart)/.test(c));
    expect(opus).toEqual(["waitForBuilds opus result", "restart opus result"]);
  });

  test("a task's own budget replaces the default cap", async () => {
    await makeArena().start({ taskId: "durable-votes" }).finished;
    expect(agents.tasks.map((t) => t.budgetUsd)).toEqual([2, 2, 2]);
  });

  test("chaos actions stop and start the container in the lane being checked, not another one", async () => {
    await makeArena().start({ taskId: "durable-votes" }).finished;
    const sonnetActions = lanes.calls.filter((c) => c.endsWith("-container sonnet db") || c.startsWith("stop-container sonnet") || c.startsWith("start-container sonnet"));
    expect([...new Set(sonnetActions)]).toEqual(["stop-container sonnet db", "start-container sonnet db"]);
  });
});

describe("Proving a task without a race", () => {
  test("prove runs a task's checks on a fresh control lane with no agents and sets it aside afterwards", async () => {
    await lanes.create({ name: "control", arena: true });
    lanes.calls = [];
    live = { control: { "/api/vote/": healthy("[]")["/api/vote/"] } };
    const baseline = await makeArena().prove("vote-healthz");
    expect(baseline).toMatchObject({ passed: 1, total: 2 });
    expect(agents.tasks).toEqual([]);
    expect(lanes.calls.filter((c) => /^(destroy|create|start|stop) /.test(c))).toEqual([
      "destroy control",
      "create control Tabs/Spaces arena",
      "start control",
      "stop control",
    ]);
  });
});
