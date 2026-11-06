import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { laneRequest } from "../src/http";

/** A tiny server that echoes what it received, standing in for a lane's Traefik. */
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) =>
      Response.json({
        method: req.method,
        host: req.headers.get("host"),
        cookie: req.headers.get("cookie"),
        body: await req.text(),
      }),
  });
});
afterAll(() => server.stop(true));

describe("laneRequest", () => {
  test("sends the lane's Host header, extra headers such as a Cookie, and the form body", async () => {
    const answer = await laneRequest({
      port: Number(server.port),
      host: "api.alpha-lane.localhost",
      method: "POST",
      path: "/api/vote/",
      form: "vote=a",
      headers: { Cookie: "voter_id=arena-same" },
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({
      method: "POST",
      host: "api.alpha-lane.localhost",
      cookie: "voter_id=arena-same",
      body: "vote=a",
    });
  });
});
