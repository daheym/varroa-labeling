import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { followPrediction, requestPrediction } from "./prediction";
import type { PredictionStatus } from "./types";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const running: PredictionStatus = { state: "running", request_id: "job-1", message: "Analyzing image" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("recovers from the initial HTTP 400 with the same request ID and displays status", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response("Invalid HTTP request received.", { status: 400 }))
    .mockResolvedValueOnce(response(running, 202))
    .mockResolvedValueOnce(response({ ...running, state: "succeeded" }))
    .mockResolvedValueOnce(response({ image_id: "image-1", annotations: [] }));
  vi.stubGlobal("fetch", fetch);
  const update = vi.fn();
  const result = requestPrediction("image-1", "model-1", update);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ image_id: "image-1", annotations: [] });
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ message: "Reconnecting to prediction request…" }));
  expect(update).toHaveBeenCalledWith(running);
});

it("reconnects after a lost start response without issuing a second inference ID", async () => {
  const fetch = vi.fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(response({ ...running, state: "succeeded" }))
    .mockResolvedValueOnce(response({ image_id: "image-1" }));
  vi.stubGlobal("fetch", fetch);
  const result = requestPrediction("image-1", "model-1", vi.fn());
  await vi.runAllTimersAsync();
  await result;
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("shows a structured validation error immediately without retrying", async () => {
  const fetch = vi.fn().mockResolvedValue(response({ detail: "Generate physical perspective correction" }, 409));
  vi.stubGlobal("fetch", fetch);
  await expect(requestPrediction("image-1", "model-1", vi.fn())).rejects.toThrow("Generate physical perspective correction (HTTP 409)");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("resumes polling an existing job after a temporary network error", async () => {
  const fetch = vi.fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(response({ ...running, state: "succeeded" }))
    .mockResolvedValueOnce(response({ image_id: "image-1" }));
  vi.stubGlobal("fetch", fetch);
  const update = vi.fn();
  const result = followPrediction("image-1", running, update);
  await vi.runAllTimersAsync();
  await result;
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ message: "Reconnecting to prediction status…" }));
  expect(fetch.mock.calls.every(([, options]) => options === undefined)).toBe(true);
});

it("reports model failure without fetching or replacing the annotation document", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(followPrediction("image-1", { state: "failed", message: "Model failed to load", error_status: 422 }, vi.fn())).rejects.toThrow("Model failed to load (HTTP 422)");
  expect(fetch).not.toHaveBeenCalled();
});

it("retries loading saved results without starting inference again", async () => {
  const fetch = vi.fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(response({ image_id: "image-1" }));
  vi.stubGlobal("fetch", fetch);
  const result = followPrediction("image-1", { ...running, state: "succeeded" }, vi.fn());
  await vi.runAllTimersAsync();
  await result;
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/images/image-1", "/api/images/image-1"]);
});
