import { describe, expect, test } from "bun:test";
import { planLane, LaneError } from "../src/plan";

const allFree = async () => true;

describe("planLane", () => {
  test("first lane gets slot 1 with its own Flisk project name and ports", async () => {
    const plan = await planLane("alpha", [], allFree);
    expect(plan).toEqual({
      name: "alpha",
      projectName: "alpha-lane",
      slot: 1,
      ports: { http: 19081, https: 19444, postgres: 19533, tilt: 10401 },
    });
  });

  test("takes the lowest slot no existing lane uses, reusing gaps", async () => {
    const existing = [
      { name: "alpha", slot: 1 },
      { name: "gamma", slot: 3 },
    ];
    const plan = await planLane("beta", existing, allFree);
    expect(plan.slot).toBe(2);
    expect(plan.ports.http).toBe(19082);
  });

  test("skips a slot when any of its ports is held by another program", async () => {
    const busy = new Set([19081, 10402]); // slot 1 http, slot 2 tilt
    const plan = await planLane("alpha", [], async (port) => !busy.has(port));
    expect(plan.slot).toBe(3);
  });

  // Flisk treats containers whose names start with "<project>-" or "<project>_" as its own
  // (cli/src/utils/host-port-config.ts:25-38), so a hyphen in a lane name could make one lane own another's ports.
  test.each([
    ["Alpha", "uppercase"],
    ["al-pha", "hyphen (Flisk prefix ownership)"],
    ["al_pha", "underscore"],
    ["1alpha", "leading digit"],
    ["", "empty"],
    ["abcdefghijklm", "longer than 12"],
    ["base", "reserved"],
  ])("rejects lane name %p (%s)", async (name) => {
    const attempt = planLane(name, [], allFree);
    await expect(attempt).rejects.toBeInstanceOf(LaneError);
    await expect(attempt).rejects.toMatchObject({ code: "INVALID_NAME" });
  });

  test("rejects a name another lane already has", async () => {
    await expect(planLane("alpha", [{ name: "alpha", slot: 1 }], allFree)).rejects.toMatchObject({
      code: "NAME_TAKEN",
    });
  });

  test("refuses to exceed the lane cap (default 3)", async () => {
    const existing = [
      { name: "a", slot: 1 },
      { name: "b", slot: 2 },
      { name: "c", slot: 3 },
    ];
    await expect(planLane("d", existing, allFree)).rejects.toMatchObject({ code: "LANE_CAP" });
    const raised = await planLane("d", existing, allFree, { maxLanes: 4 });
    expect(raised.slot).toBe(4);
  });

  test("arena lanes have their own cap but never reuse a regular lane's slot or name", async () => {
    const regular = [
      { name: "alpha", slot: 1 },
      { name: "beta", slot: 2 },
      { name: "gamma", slot: 3 },
    ];
    const arenaLane = await planLane("haiku", regular, allFree, { kind: "arena" });
    expect(arenaLane.slot).toBe(4);
    await expect(planLane("alpha", regular, allFree, { kind: "arena" })).rejects.toMatchObject({ code: "NAME_TAKEN" });
  });

  test("the arena cap counts only arena lanes, and the regular cap only regular ones", async () => {
    const arena = [
      { name: "haiku", slot: 1, arena: true },
      { name: "sonnet", slot: 2, arena: true },
      { name: "opus", slot: 3, arena: true },
    ];
    await expect(planLane("extra", arena, allFree, { kind: "arena" })).rejects.toMatchObject({ code: "LANE_CAP" });
    expect((await planLane("alpha", arena, allFree)).slot).toBe(4);
  });
});
