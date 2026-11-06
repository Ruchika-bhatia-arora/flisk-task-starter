import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LaneView } from "../src/manager";
import { LaneError } from "../src/plan";
import { type Dashboard, type LaneService, startDashboard } from "../src/server";

const alphaView: LaneView = {
  name: "alpha",
  projectName: "alpha-lane",
  slot: 1,
  ports: { http: 19081, https: 19444, postgres: 19533, tilt: 10401 },
  dir: "/tmp/x/.lanes/alpha",
  pair: { a: "Tabs", b: "Spaces" },
  createdAt: "2026-11-05T10:00:00.000Z",
  urls: {
    vote: "http://api.alpha-lane.localhost:19081/api/vote/",
    result: "http://api.alpha-lane.localhost:19081/api/result/",
    tilt: "http://localhost:10401",
  },
  state: "running",
  activity: null,
  services: [{ name: "vote", status: "ready", url: null }],
  lastError: null,
};

/** Records calls; behaves like a LaneManager with one lane, "alpha". */
class FakeLanes implements LaneService {
  calls: string[] = [];
  async snapshot() {
    return [alphaView];
  }
  async create(request: { name?: string }) {
    this.calls.push(`create ${request.name ?? "(auto)"}`);
    if (request.name === "Bad-Name") throw new LaneError("INVALID_NAME", "bad name");
    if (request.name === "four") throw new LaneError("LANE_CAP", "cap reached");
    return { ...alphaView, name: request.name ?? "beta" };
  }
  async start(name: string) {
    this.calls.push(`start ${name}`);
    return { ok: true, failures: [] };
  }
  async stop(name: string) {
    this.calls.push(`stop ${name}`);
  }
  async destroy(name: string) {
    this.calls.push(`destroy ${name}`);
    if (name !== "alpha") throw new LaneError("UNKNOWN_LANE", `No lane named ${name}`);
  }
  async castVotes(name: string, count: number, choice: "a" | "b") {
    this.calls.push(`castVotes ${name} ${count} ${choice}`);
    return { sent: count, accepted: count };
  }
  async voteCounts(name: string) {
    this.calls.push(`voteCounts ${name}`);
    return { a: 10, b: 0 };
  }
}

let lanes: FakeLanes;
let dashboard: Dashboard;

beforeEach(() => {
  lanes = new FakeLanes();
  dashboard = startDashboard({ lanes, port: 0, pollMs: 20, voteSettleMs: 0 });
});

afterEach(() => dashboard.stop());

const api = (path: string, init?: RequestInit) => fetch(new URL(path, dashboard.url), init);
const post = (path: string, body?: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

describe("dashboard API", () => {
  test("GET /api/lanes returns every lane with its live state", async () => {
    const res = await api("/api/lanes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lanes: [alphaView] });
  });

  test("POST /api/lanes creates a lane and starts it in the background", async () => {
    const res = await post("/api/lanes", { name: "beta" });
    expect(res.status).toBe(201);
    expect((await res.json()).lane.name).toBe("beta");
    await Bun.sleep(5);
    expect(lanes.calls).toEqual(["create beta", "start beta"]);
  });

  test("a bad name is a 400 and a full machine is a 409, each with Lanes' error code", async () => {
    const bad = await post("/api/lanes", { name: "Bad-Name" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("INVALID_NAME");
    const full = await post("/api/lanes", { name: "four" });
    expect(full.status).toBe(409);
    expect((await full.json()).error.code).toBe("LANE_CAP");
  });

  test("start, stop and destroy answer 202 at once and do the work in the background", async () => {
    expect((await post("/api/lanes/alpha/start")).status).toBe(202);
    expect((await post("/api/lanes/alpha/stop")).status).toBe(202);
    expect((await api("/api/lanes/alpha", { method: "DELETE" })).status).toBe(202);
    await Bun.sleep(5);
    expect(lanes.calls).toEqual(["start alpha", "stop alpha", "destroy alpha"]);
  });

  test("casting votes returns what was accepted and the lane's counts afterwards", async () => {
    const res = await post("/api/lanes/alpha/votes", { count: 10, choice: "a" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 10, accepted: 10, counts: { a: 10, b: 0 } });
    expect(lanes.calls[0]).toBe("castVotes alpha 10 a");
  });

  test("vote requests outside 1-100 votes or not for a or b are refused", async () => {
    expect((await post("/api/lanes/alpha/votes", { count: 0, choice: "a" })).status).toBe(400);
    expect((await post("/api/lanes/alpha/votes", { count: 10, choice: "c" })).status).toBe(400);
    expect(lanes.calls).toEqual([]);
  });

  test("GET /api/lanes/:name/counts reads the lane's vote counts", async () => {
    const res = await api("/api/lanes/alpha/counts");
    expect(await res.json()).toEqual({ counts: { a: 10, b: 0 } });
  });

  test("GET /api/events streams the lanes as server-sent events", async () => {
    const res = await api("/api/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(value);
    expect(text.startsWith("event: lanes\ndata: ")).toBe(true);
    expect(JSON.parse(text.split("data: ")[1]).lanes[0].name).toBe("alpha");
  });

  test("unknown routes are 404", async () => {
    expect((await api("/api/nope")).status).toBe(404);
  });
});
