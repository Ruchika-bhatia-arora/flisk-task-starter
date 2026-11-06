import { describe, expect, test } from "bun:test";
import { NETWORKS_PER_LANE, networkRoom, subnetCapacity } from "../src/capacity";

describe("Docker network room", () => {
  test("Docker's default pools hold 31 networks (15 x /16 in 172.17-31, 16 x /20 in 192.168/16)", () => {
    expect(subnetCapacity(null)).toBe(31);
  });

  test("a custom pool holds 2^(size - prefix) networks", () => {
    expect(subnetCapacity([{ Base: "10.210.0.0/16", Size: 24 }])).toBe(256);
    expect(subnetCapacity([{ Base: "10.210.0.0/16", Size: 24 }, { Base: "10.211.0.0/20", Size: 24 }])).toBe(272);
  });

  test("room counts every network that has a subnet; host and none have none", () => {
    const names = ["bridge", "host", "none", ...Array.from({ length: 21 }, (_, i) => `alpha_lane_${i}`)];
    expect(networkRoom(31, names)).toEqual({ capacity: 31, used: 22, free: 9, lanes: 1 });
    expect(NETWORKS_PER_LANE).toBe(7);
  });
});
