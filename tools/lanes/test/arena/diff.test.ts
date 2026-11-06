import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyToBase, diffLane } from "../../src/arena/diff";

let root: string;
let base: string;
let lane: string;

const put = (dir: string, path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arena-diff-"));
  base = join(root, "base");
  lane = join(root, "lane");
  for (const dir of [base, lane]) {
    put(dir, "result/server.js", "var port = 80;\nvar votes = {a: 0, b: 0};\n");
    put(dir, "vote/app.py", "print('vote')\n");
    put(dir, "vote/templates/old.html", "<p>old</p>\n");
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("diffLane", () => {
  test("finds what the agent modified, added and deleted, with line counts and a unified patch", async () => {
    put(lane, "result/server.js", "var port = 80;\nvar votes = {a: 0, b: 0, c: 0};\n");
    put(lane, "result/options.js", "module.exports = {};\n");
    rmSync(join(lane, "vote/templates/old.html"));
    const diff = await diffLane(base, lane);
    expect(diff.files).toEqual([
      { path: "result/options.js", change: "added", added: 1, removed: 0 },
      { path: "result/server.js", change: "modified", added: 1, removed: 1 },
      { path: "vote/templates/old.html", change: "deleted", added: 0, removed: 1 },
    ]);
    expect([diff.added, diff.removed]).toEqual([2, 2]);
    expect(diff.patch).toContain("+++ b/result/server.js");
    expect(diff.patch).toContain("+var votes = {a: 0, b: 0, c: 0};");
  });

  test("only looks at app code: Flisk config, secrets, dependencies and lane tools are not the agent's change", async () => {
    put(lane, "services/x/vote/service.json", "{}");
    put(lane, ".flisk/project.json", "{}");
    put(lane, ".env", "SECRET=1\n");
    put(lane, "result/node_modules/lib/index.js", "x\n");
    put(lane, ".arena-tools/lane-curl", "#!/bin/sh\n");
    put(lane, "worker/bin/Debug/app.dll", "binary");
    const diff = await diffLane(base, lane);
    expect(diff.files).toEqual([]);
    expect(diff.patch).toBe("");
  });
});

describe("applyToBase", () => {
  test("writes the lane's changes into the base and backs up every file it overwrites or deletes", async () => {
    put(lane, "result/server.js", "var votes = {a: 0, b: 0, c: 0};\n");
    put(lane, "result/options.js", "module.exports = {};\n");
    rmSync(join(lane, "vote/templates/old.html"));
    const backups = join(root, "backups");
    const diff = await diffLane(base, lane);
    const written = applyToBase(base, lane, diff, backups);
    expect(written).toEqual(["result/options.js", "result/server.js", "vote/templates/old.html"]);
    expect(read(base, "result/server.js")).toBe("var votes = {a: 0, b: 0, c: 0};\n");
    expect(read(base, "result/options.js")).toBe("module.exports = {};\n");
    expect(existsSync(join(base, "vote/templates/old.html"))).toBe(false);
    expect(read(backups, "result/server.js")).toBe("var port = 80;\nvar votes = {a: 0, b: 0};\n");
    expect(read(backups, "vote/templates/old.html")).toBe("<p>old</p>\n");
    expect(existsSync(join(backups, "result/options.js"))).toBe(false);
  });

  test("refuses a change list that points outside the app folders", async () => {
    const forged = { files: [{ path: "../.env", change: "modified" as const, added: 1, removed: 0 }], patch: "", added: 1, removed: 0 };
    expect(() => applyToBase(base, lane, forged, join(root, "backups"))).toThrow(/outside the app folders/);
  });
});
