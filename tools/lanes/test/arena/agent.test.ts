import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentResult } from "../../src/arena/agent";

/** Real `claude -p --bare --output-format json` output from Claude Code 2.1.318, recorded with Haiku 5.5. */
const recorded = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "fixtures", "claude", `${name}.fixture.txt`), "utf8");

describe("parseAgentResult", () => {
  test("a finished run gives its summary, cost, time and turns", () => {
    expect(parseAgentResult(recorded("success"), 0)).toEqual({
      outcome: "finished",
      summary: "READY",
      costUsd: 0.0002029,
      durationMs: 978,
      turns: 1,
      deniedTools: [],
    });
  });

  test("a run stopped by its budget is 'over budget', with what it really spent (the cap is soft)", () => {
    const result = parseAgentResult(recorded("over-budget"), 1);
    expect(result.outcome).toBe("over_budget");
    expect(result.summary).toBe("Reached maximum budget ($0.0001)");
    expect(result.costUsd).toBeCloseTo(0.00200462, 8);
  });

  test("output that is not Claude's JSON is an agent error carrying the text", () => {
    expect(parseAgentResult("Error: not logged in\n", 1)).toEqual({
      outcome: "error",
      summary: "Error: not logged in",
      costUsd: 0,
      durationMs: 0,
      turns: 0,
      deniedTools: [],
    });
  });

  test("refused tool calls are reported with the command the agent tried", () => {
    expect(parseAgentResult(recorded("denied"), 0).deniedTools).toEqual([
      "Bash: curl -s http://127.0.0.1:9/ ; ./.arena-tools/lane-curl /api/vote/ | head -1",
    ]);
  });
});
