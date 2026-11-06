import { describe, expect, test } from "bun:test";
import { type Check, type CheckIO, runChecks } from "../../src/arena/checks";

const vars = { A: "Tabs", B: "Spaces" };

/** A lane that answers from a table of canned responses; time only moves when the runner sleeps. */
function fakeLane(responses: Record<string, Array<{ status: number; body: string }>>, sql: Record<string, string> = {}) {
  let clock = 0;
  const requests: string[] = [];
  const actions: string[] = [];
  const restarts: Record<string, number> = {};
  const io: CheckIO = {
    async http({ method, path, form, headers }) {
      const key = `${method} ${path}`;
      const cookie = headers?.Cookie ? ` [${headers.Cookie}]` : "";
      requests.push((form ? `${key} ${form}` : key) + cookie);
      const queue = responses[key] ?? [{ status: 404, body: "not found" }];
      return queue.length > 1 ? (queue.shift() as { status: number; body: string }) : queue[0];
    },
    async sql(query) {
      return { ok: query in sql, stdout: sql[query] ?? "", stderr: query in sql ? "" : "relation does not exist" };
    },
    async action(verb, service) {
      actions.push(`${verb} ${service}`);
      if (service === "missing") throw new Error("no container for service missing");
    },
    async restartCount(service) {
      return restarts[service] ?? 0;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { io, requests, actions, restarts, advance: (ms: number) => (clock += ms) };
}

describe("runChecks", () => {
  test("a check passes when the live app answers as expected", async () => {
    const checks: Check[] = [
      { id: "page", label: "Results page loads", kind: "http", method: "GET", path: "/api/result/", expect: { status: 200, contains: ["<html"] } },
    ];
    const { io } = fakeLane({ "GET /api/result/": [{ status: 200, body: "<html>ok</html>" }] });
    expect(await runChecks(checks, vars, io)).toEqual([
      { id: "page", label: "Results page loads", passed: true, detail: "ok", attempts: 1 },
    ]);
  });

  test("a failing check is retried until the deadline, then reported with the reason", async () => {
    const checks: Check[] = [
      { id: "healthz", label: "Health endpoint", kind: "http", method: "GET", path: "/api/vote/healthz", expect: { status: 200 } },
    ];
    const { io } = fakeLane({});
    const [result] = await runChecks(checks, vars, io, { deadlineMs: 10_000, retryMs: 2_000 });
    expect(result.passed).toBe(false);
    expect(result.detail).toBe("expected status 200, got 404");
    expect(result.attempts).toBe(6);
  });

  test("a check that starts failing and then passes (service still restarting) counts as passed", async () => {
    const checks: Check[] = [
      { id: "healthz", label: "Health endpoint", kind: "http", method: "GET", path: "/api/vote/healthz", expect: { status: 200 } },
    ];
    const { io } = fakeLane({
      "GET /api/vote/healthz": [
        { status: 502, body: "bad gateway" },
        { status: 200, body: "{}" },
      ],
    });
    const [result] = await runChecks(checks, vars, io, { deadlineMs: 10_000, retryMs: 1_000 });
    expect(result).toMatchObject({ passed: true, attempts: 2 });
  });

  test("JSON expectations use the lane's own options", async () => {
    const checks: Check[] = [
      { id: "opts", label: "Options endpoint", kind: "http", method: "GET", path: "/api/result/options", expect: { status: 200, json: { a: "{A}", b: "{B}" } } },
    ];
    const right = fakeLane({ "GET /api/result/options": [{ status: 200, body: '{"a":"Tabs","b":"Spaces","extra":1}' }] });
    expect((await runChecks(checks, vars, right.io))[0].passed).toBe(true);
    const wrong = fakeLane({ "GET /api/result/options": [{ status: 200, body: '{"a":"Cats","b":"Spaces"}' }] });
    const [result] = await runChecks(checks, vars, wrong.io, { deadlineMs: 0 });
    expect(result.detail).toBe('expected "a" to be "Tabs", got "Cats"');
  });

  test("an answer that is not JSON fails a JSON expectation with a clear reason", async () => {
    const checks: Check[] = [
      { id: "scores", label: "Scores", kind: "http", method: "GET", path: "/api/result/scores", expect: { jsonKeys: ["a", "b", "c"] } },
    ];
    const notJson = fakeLane({ "GET /api/result/scores": [{ status: 200, body: "<html>" }] });
    expect((await runChecks(checks, vars, notJson.io, { deadlineMs: 0 }))[0].detail).toBe("the answer is not JSON");
    const missing = fakeLane({ "GET /api/result/scores": [{ status: 200, body: '{"a":1,"b":2}' }] });
    expect((await runChecks(checks, vars, missing.io, { deadlineMs: 0 }))[0].detail).toBe('the JSON has no "c"');
  });

  test("notContains catches what must be gone", async () => {
    const checks: Check[] = [
      { id: "labels", label: "No hard-coded labels", kind: "http", method: "GET", path: "/api/result/", expect: { notContains: ["Cats"] } },
    ];
    const { io } = fakeLane({ "GET /api/result/": [{ status: 200, body: '<div class="label">Cats</div>' }] });
    expect((await runChecks(checks, vars, io, { deadlineMs: 0 }))[0].detail).toBe('the answer still contains "Cats"');
  });

  test("a POST sends its form, and a db check reads the lane's Postgres", async () => {
    const checks: Check[] = [
      { id: "vote-c", label: "Vote for C", kind: "http", method: "POST", path: "/api/vote/", form: "vote=c", expect: { status: 200 } },
      { id: "stored", label: "C is stored", kind: "db", sql: "select count(*) from votes where vote = 'c'", expect: { atLeast: 1 } },
    ];
    const { io, requests } = fakeLane(
      { "POST /api/vote/": [{ status: 200, body: "ok" }] },
      { "select count(*) from votes where vote = 'c'": "1\n" },
    );
    const results = await runChecks(checks, vars, io);
    expect(results.map((r) => r.passed)).toEqual([true, true]);
    expect(requests).toEqual(["POST /api/vote/ vote=c"]);
  });

  test("a db check below its minimum says what it found", async () => {
    const checks: Check[] = [
      { id: "stored", label: "C is stored", kind: "db", sql: "select count(*) from votes where vote = 'c'", expect: { atLeast: 1 } },
    ];
    const zero = fakeLane({}, { "select count(*) from votes where vote = 'c'": "0\n" });
    expect((await runChecks(checks, vars, zero.io, { deadlineMs: 0 }))[0].detail).toBe("expected at least 1, found 0");
    const broken = fakeLane({});
    expect((await runChecks(checks, vars, broken.io, { deadlineMs: 0 }))[0].detail).toBe("query failed: relation does not exist");
  });

  test("placeholders are filled inside JSON arrays too", async () => {
    const checks: Check[] = [
      { id: "healthz", label: "Health", kind: "http", method: "GET", path: "/api/vote/healthz", expect: { json: { status: "ok", options: ["{A}", "{B}"] } } },
    ];
    const { io } = fakeLane({ "GET /api/vote/healthz": [{ status: 200, body: '{"status":"ok","options":["Tabs","Spaces"]}' }] });
    expect((await runChecks(checks, vars, io, { deadlineMs: 0 }))[0]).toMatchObject({ passed: true });
  });

  test("a repeated request fills {i} into headers and form, and every answer must match", async () => {
    const checks: Check[] = [
      {
        id: "ten",
        label: "Ten voters vote",
        kind: "http",
        method: "POST",
        path: "/api/vote/",
        form: "vote=a",
        headers: { Cookie: "voter_id=arena-d{i}" },
        repeat: 3,
        expect: { status: 200 },
      },
    ];
    const { io, requests } = fakeLane({ "POST /api/vote/": [{ status: 200, body: "ok" }] });
    expect((await runChecks(checks, vars, io))[0].passed).toBe(true);
    expect(requests).toEqual([
      "POST /api/vote/ vote=a [voter_id=arena-d1]",
      "POST /api/vote/ vote=a [voter_id=arena-d2]",
      "POST /api/vote/ vote=a [voter_id=arena-d3]",
    ]);
  });

  test("db checks can demand an exact number, an exact text, or at most a number", async () => {
    const q = (sql: string, expect: { equals?: number | string; atMost?: number }): Check => ({ id: sql, label: sql, kind: "db", sql, expect });
    const { io } = fakeLane({}, { ten: "10\n", nine: "9\n", vote: "b\n", invalid: "2\n" });
    const results = await runChecks(
      [q("ten", { equals: 10 }), q("nine", { equals: 10 }), q("vote", { equals: "b" }), q("invalid", { atMost: 0 })],
      vars,
      io,
      { deadlineMs: 0 },
    );
    expect(results.map((r) => r.detail)).toEqual(["ok", "expected 10, found 9", "ok", "expected at most 0, found 2"]);
  });

  test("actions stop and start a lane's service once; a wait only lets time pass", async () => {
    const checks: Check[] = [
      { id: "stop", label: "Stop Postgres", kind: "action", do: "stop", service: "db" },
      { id: "pause", label: "Wait 5 s", kind: "wait", seconds: 5 },
      { id: "start", label: "Start Postgres", kind: "action", do: "start", service: "db" },
      { id: "bad", label: "Stop a missing service", kind: "action", do: "stop", service: "missing" },
    ];
    const lane = fakeLane({});
    const results = await runChecks(checks, vars, lane.io, { deadlineMs: 0 });
    expect(lane.actions).toEqual(["stop db", "start db", "stop missing"]);
    expect(lane.io.now()).toBe(5000);
    expect(results.map((r) => r.passed)).toEqual([true, true, true, false]);
    expect(results[3].detail).toBe("stop missing failed: no container for service missing");
  });

  test("a restart check counts only restarts that happened during this run of the checks", async () => {
    const lane = fakeLane({});
    lane.restarts.worker = 2; // restarts from before the checks started do not count
    const checks: Check[] = [
      { id: "crash", label: "Something happens", kind: "wait", seconds: 1 },
      { id: "steady", label: "The worker never restarted", kind: "restarts", service: "worker", expect: { atMost: 0 } },
    ];
    const original = lane.io.sleep;
    lane.io.sleep = async (ms) => {
      lane.restarts.worker = 3;
      await original(ms);
    };
    const [, steady] = await runChecks(checks, vars, lane.io, { deadlineMs: 0 });
    expect(steady.detail).toBe("worker restarted 1 time(s) during the checks (at most 0 allowed)");
  });

  test("each check gets its own retry window, so an early failure cannot starve later checks", async () => {
    const checks: Check[] = [
      { id: "never", label: "Never passes", kind: "http", method: "GET", path: "/nope", expect: { status: 200 } },
      { id: "later", label: "Passes on the second try", kind: "http", method: "GET", path: "/later", expect: { status: 200 } },
    ];
    const { io } = fakeLane({ "GET /later": [{ status: 502, body: "" }, { status: 200, body: "" }] });
    const results = await runChecks(checks, vars, io, { deadlineMs: 10_000, retryMs: 1_000 });
    expect(results.map((r) => r.passed)).toEqual([false, true]);
  });

  test("a check can ask for a longer retry window than the default", async () => {
    const checks: Check[] = [
      { id: "slow", label: "Slow", kind: "http", method: "GET", path: "/slow", withinMs: 30_000, expect: { status: 200 } },
    ];
    const { io } = fakeLane({});
    const [result] = await runChecks(checks, vars, io, { deadlineMs: 5_000, retryMs: 10_000 });
    expect(result.attempts).toBe(4);
  });

  test("a service can be frozen and unfrozen (docker pause), to catch a worker holding work when a dependency dies", async () => {
    const checks: Check[] = [
      { id: "freeze", label: "Freeze the worker", kind: "action", do: "pause", service: "worker" },
      { id: "thaw", label: "Unfreeze the worker", kind: "action", do: "unpause", service: "worker" },
    ];
    const lane = fakeLane({});
    const results = await runChecks(checks, vars, lane.io, { deadlineMs: 0 });
    expect(lane.actions).toEqual(["pause worker", "unpause worker"]);
    expect(results.every((r) => r.passed)).toBe(true);
  });
});
