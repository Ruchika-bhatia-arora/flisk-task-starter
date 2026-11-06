import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformLane, type LaneFiles } from "../src/transform";
import { portsForSlot } from "../src/plan";

const FIXTURES = join(import.meta.dir, "fixtures", "import");
const STACK = "services/flisk-task-starter-main";

/** The files `flisk import` (1.4.37) wrote for the starter, keyed by their path in the project. */
function importedFiles(): LaneFiles {
  const files: LaneFiles = new Map();
  files.set(".flisk/project.json", readFileSync(join(FIXTURES, "project.fixture.json"), "utf8"));
  files.set(".env", readFileSync(join(FIXTURES, "env.fixture"), "utf8"));
  for (const svc of ["vote", "result", "db", "redis", "seed", "worker"]) {
    files.set(`${STACK}/${svc}/service.json`, readFileSync(join(FIXTURES, `${svc}.service.fixture.json`), "utf8"));
  }
  return files;
}

const lane = {
  plan: { name: "alpha", projectName: "alpha-lane", slot: 2, ports: portsForSlot(2) },
  pair: { a: "Tabs", b: "Spaces" },
};

const json = (files: LaneFiles, path: string) => JSON.parse(files.get(path) ?? "null");

describe("transformLane", () => {
  test("renames the Flisk project to the lane's project name", () => {
    const out = transformLane(importedFiles(), lane);
    expect(json(out, ".flisk/project.json").project.name).toBe("alpha-lane");
  });

  test("drops composeProjectNames so a future Flisk cannot pin every lane to the base Compose project", () => {
    const out = transformLane(importedFiles(), lane);
    expect(json(out, ".flisk/project.json").composeProjectNames).toBeUndefined();
  });

  test("gives Postgres a lane-scoped volume instead of the base project's fixed name", () => {
    const out = transformLane(importedFiles(), lane);
    const volumes = json(out, `${STACK}/db/service.json`).volumes;
    // The import pinned name "flisk-task-starter-main_db-data": every copy would mount the same data.
    expect(volumes).toEqual([
      { source: "db-data", target: "/var/lib/postgresql/data" },
      { source: "../../../healthchecks", target: "/healthchecks" },
    ]);
  });

  test("publishes no fixed host ports, so a second lane cannot collide on 8080, 8081 or 9229", () => {
    const out = transformLane(importedFiles(), lane);
    expect(json(out, `${STACK}/vote/service.json`).extraPorts).toBeUndefined();
    expect(json(out, `${STACK}/result/service.json`).extraPorts).toBeUndefined();
  });

  test("gives the lane's vote page its own pair of options", () => {
    const out = transformLane(importedFiles(), lane);
    expect(json(out, `${STACK}/vote/service.json`).env).toEqual({ OPTION_A: "Tabs", OPTION_B: "Spaces" });
  });

  test("tells the results service the same options, so its page can show them", () => {
    const out = transformLane(importedFiles(), lane);
    expect(json(out, `${STACK}/result/service.json`).env).toEqual({ OPTION_A: "Tabs", OPTION_B: "Spaces" });
  });

  test("leaves the rest of a service.json as the import wrote it", () => {
    const before = json(importedFiles(), `${STACK}/vote/service.json`);
    const after = json(transformLane(importedFiles(), lane), `${STACK}/vote/service.json`);
    const { extraPorts: _p, env: _e, ...unchangedAfter } = after;
    const { extraPorts: _q, ...unchangedBefore } = before;
    expect(unchangedAfter).toEqual(unchangedBefore);
    expect(json(transformLane(importedFiles(), lane), `${STACK}/worker/service.json`)).toEqual(
      json(importedFiles(), `${STACK}/worker/service.json`),
    );
  });

  test("writes a .env that keeps the base secrets and pins the lane's Flisk ports", () => {
    const env = transformLane(importedFiles(), lane).get(".env") ?? "";
    expect(env).toContain("POSTGRES_PASSWORD=postgres\n");
    expect(env).toContain("FLISK_HTTP_PORT=19082\n");
    expect(env).toContain("FLISK_HTTPS_PORT=19445\n");
    expect(env).toContain("FLISK_POSTGRES_PORT=19534\n");
  });

  test("replaces port lines copied from the base .env instead of adding a second one", () => {
    const files = importedFiles();
    files.set(".env", "POSTGRES_PASSWORD=postgres\nFLISK_HTTP_PORT=80\n");
    const env = transformLane(files, lane).get(".env") ?? "";
    expect(env.match(/^FLISK_HTTP_PORT=/gm)).toHaveLength(1);
    expect(env).toContain("FLISK_HTTP_PORT=19082\n");
  });

  test("writes a .env even when the base project has none", () => {
    const files = importedFiles();
    files.delete(".env");
    expect(transformLane(files, lane).get(".env")).toContain("FLISK_HTTP_PORT=19082\n");
  });

  test("drops the base project's JWT_SECRET so each lane's Flisk generates its own", () => {
    const files = importedFiles();
    files.set(".env", "POSTGRES_PASSWORD=postgres\nTILT_ENV=dev\nJWT_SECRET=base-secret\n");
    const env = transformLane(files, lane).get(".env") ?? "";
    expect(env).not.toContain("JWT_SECRET");
    expect(env).toContain("TILT_ENV=dev\n");
  });
});
