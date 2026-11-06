import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRun, parseStatus, parseUp } from "../src/parse";

/** Real output of Flisk 1.4.37 on this starter, recorded during the base run (home path replaced). */
const recorded = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "flisk", `${name}.fixture.txt`), "utf8");

describe("parseUp (flisk up --wait --json)", () => {
  test("a ready stack is ok, even though --wait prints trailing UP_FAILED envelopes after the result", () => {
    expect(parseUp(recorded("up-wait-ok"), 0)).toEqual({ ok: true, failures: [] });
  });

  test("a failed start names the service that failed", () => {
    const result = parseUp(recorded("up-failed-port"), 1);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.name)).toEqual(["result"]);
    expect(result.failures[0].message).toContain("docker");
  });

  test("output with no envelope at all is a failure that carries the raw text", () => {
    const result = parseUp("tilt: command not found\n", 127);
    expect(result).toEqual({ ok: false, failures: [{ name: "flisk", message: "tilt: command not found" }] });
  });
});

describe("parseStatus (flisk status --json)", () => {
  test("a running stack lists each service with its state and routed URL", () => {
    const status = parseStatus(recorded("status-ready"));
    expect(status.tiltRunning).toBe(true);
    expect(status.services).toContainEqual({
      name: "vote",
      status: "ready",
      url: "http://api.flisk-task-starter-main.localhost/api/vote",
    });
    expect(status.services).toContainEqual({ name: "worker", status: "ready", url: null });
  });

  test("after flisk down the stack is not running, although tilt.available still says true", () => {
    expect(parseStatus(recorded("status-stopped")).tiltRunning).toBe(false);
  });
});

describe("parseRun (flisk run --json)", () => {
  test("returns the command's exit code and output", () => {
    expect(parseRun(recorded("run-psql"))).toEqual({ exitCode: 0, stdout: "a|1\n", stderr: "" });
  });
});
