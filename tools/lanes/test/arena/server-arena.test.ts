import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ArenaRun } from "../../src/arena/arena";
import { type ArenaService, type Dashboard, type LaneService, startDashboard } from "../../src/server";

const run: ArenaRun = {
  id: "20261105-120000",
  task: { id: "vote-healthz", title: "Health endpoint on the vote app", difficulty: "warm-up", request: "…", unverified: false },
  pair: { a: "Tabs", b: "Spaces" },
  startedAt: "2026-11-05T12:00:00.000Z",
  contestants: [{ model: "sonnet", modelId: "claude-sonnet-5-5", lane: "sonnet", stage: "agent" }],
};

class FakeArena implements ArenaService {
  calls: string[] = [];
  running = false;
  latestRun: ArenaRun | null = null;
  start(request: { taskId?: string; freeText?: string }) {
    this.calls.push(`start ${request.taskId ?? request.freeText}`);
    this.latestRun = run;
    return { run, finished: Promise.resolve(run) };
  }
  latest() {
    return this.latestRun;
  }
  isRunning() {
    return this.running;
  }
  patch(id: string, model: string) {
    return `--- a/${id}/${model}\n`;
  }
  async startLane(model: string) {
    this.calls.push(`startLane ${model}`);
    return { ok: true, failures: [] };
  }
  async apply(id: string, model: string) {
    this.calls.push(`apply ${id} ${model}`);
    if (model === "haiku") throw new Error("haiku did not pass its checks (failed), so it is not applied");
    return ["result/server.js"];
  }
}

const noLanes: LaneService = {
  snapshot: async () => [],
  create: async () => {
    throw new Error("unused");
  },
  start: async () => ({ ok: true, failures: [] }),
  stop: async () => undefined,
  destroy: async () => undefined,
  castVotes: async () => ({ sent: 0, accepted: 0 }),
  voteCounts: async () => ({ a: 0, b: 0 }),
};

let arena: FakeArena;
let dashboard: Dashboard;
beforeEach(() => {
  arena = new FakeArena();
  dashboard = startDashboard({ lanes: noLanes, arena, port: 0, pollMs: 20, voteSettleMs: 0 });
});
afterEach(() => dashboard.stop());

const api = (path: string, init?: RequestInit) => fetch(new URL(path, dashboard.url), init);
const post = (path: string, body?: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

describe("dashboard Arena API", () => {
  test("lists the preset tasks with their acceptance checks", async () => {
    const { tasks } = await (await api("/api/arena/tasks")).json();
    expect(tasks.map((t: { id: string }) => t.id)).toEqual(["result-labels", "vote-healthz", "third-option", "durable-votes"]);
    expect(tasks[0].checks[0]).toBe("GET /api/result/options answers with this lane's options");
  });

  test("starting a race answers 202 with the run; a second race while one runs is a 409", async () => {
    const res = await post("/api/arena/runs", { taskId: "vote-healthz" });
    expect(res.status).toBe(202);
    expect((await res.json()).run.id).toBe(run.id);
    arena.running = true;
    const busy = await post("/api/arena/runs", { taskId: "vote-healthz" });
    expect(busy.status).toBe(409);
    expect((await busy.json()).error.code).toBe("RACE_RUNNING");
    expect(arena.calls).toEqual(["start vote-healthz"]);
  });

  test("an unknown task id or an empty request is a 400", async () => {
    expect((await post("/api/arena/runs", { taskId: "nope" })).status).toBe(400);
    expect((await post("/api/arena/runs", {})).status).toBe(400);
  });

  test("the live stream carries the race next to the lanes", async () => {
    arena.latestRun = run;
    const res = await api("/api/events");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const payload = JSON.parse(new TextDecoder().decode(value).split("data: ")[1]);
    expect(payload.arena.id).toBe(run.id);
  });

  test("a contestant's patch is served as text, and applying answers with the files written", async () => {
    const patch = await api(`/api/arena/runs/${run.id}/patch/sonnet`);
    expect(patch.headers.get("content-type")).toContain("text/plain");
    expect(await patch.text()).toBe(`--- a/${run.id}/sonnet\n`);
    const applied = await post(`/api/arena/runs/${run.id}/apply/sonnet`);
    expect(await applied.json()).toEqual({ written: ["result/server.js"] });
  });

  test("applying a contestant that did not pass is refused with the reason", async () => {
    const res = await post(`/api/arena/runs/${run.id}/apply/haiku`);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain("did not pass");
  });

  test("a race lane can be started again from the dashboard to try it live", async () => {
    const res = await post("/api/arena/lanes/sonnet/start");
    expect(res.status).toBe(202);
    await Bun.sleep(5);
    expect(arena.calls).toEqual(["startLane sonnet"]);
  });
});
