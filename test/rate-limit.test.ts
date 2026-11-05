import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { Hono } from "hono";
import { rateLimit, rateLimitBucketCount, resetRateLimits } from "../src/auth/middleware.ts";

function app() {
  const a = new Hono();
  a.use("/x", rateLimit("t", 2));
  a.get("/x", (c) => c.text("ok"));
  return a;
}

const hit = (a: Hono, ip: string) => a.request("/x", { headers: { "x-forwarded-for": ip } });

beforeEach(() => resetRateLimits());
afterEach(() => setSystemTime());

describe("rateLimit", () => {
  test("limits per IP", async () => {
    const a = app();
    expect((await hit(a, "1.1.1.1")).status).toBe(200);
    expect((await hit(a, "1.1.1.1")).status).toBe(200);
    expect((await hit(a, "1.1.1.1")).status).toBe(429);
    expect((await hit(a, "2.2.2.2")).status).toBe(200);
  });

  test("idle buckets are evicted after a minute", async () => {
    const a = app();
    const t0 = new Date("2026-01-01T00:00:00Z");
    setSystemTime(t0);
    for (let i = 0; i < 50; i++) await hit(a, `10.0.0.${i}`);
    expect(rateLimitBucketCount()).toBe(50);

    setSystemTime(new Date(t0.getTime() + 61_000));
    await hit(a, "9.9.9.9");
    expect(rateLimitBucketCount()).toBe(1);
  });

  test("an exhausted IP stays limited until it refills", async () => {
    const a = app();
    const t0 = new Date("2026-01-01T00:00:00Z");
    setSystemTime(t0);
    await hit(a, "1.1.1.1");
    await hit(a, "1.1.1.1");
    setSystemTime(new Date(t0.getTime() + 5_000));
    expect((await hit(a, "1.1.1.1")).status).toBe(429);
  });
});
