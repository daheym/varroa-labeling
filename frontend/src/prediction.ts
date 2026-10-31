import { api, ApiError, json } from "./api";
import type { Doc, PredictionStatus } from "./types";

const pause = () => new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
const transient = (error: unknown) =>
  error instanceof TypeError || (error instanceof ApiError && error.retryable);

export async function followPrediction(
  imageId: string,
  initial: PredictionStatus,
  onStatus: (status: PredictionStatus) => void,
): Promise<Doc> {
  let job = initial;
  let failures = 0;
  while (job.state === "running") {
    onStatus(job);
    await pause();
    try {
      job = await api<PredictionStatus>(
        `/api/images/${imageId}/prediction?request_id=${encodeURIComponent(initial.request_id!)}`,
      );
      failures = 0;
    } catch (error) {
      if (!transient(error) || ++failures > 3) throw error;
      job = { ...job, message: "Reconnecting to prediction status…" };
      // Keep the last job so we reconnect without starting inference again.
    }
  }
  if (job.state !== "succeeded") {
    throw new Error(job.state === "failed"
      ? `${job.message}${job.error_status ? ` (HTTP ${job.error_status})` : ""}`
      : "Prediction status was lost. The API may have restarted; request predictions again.");
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<Doc>(`/api/images/${imageId}`);
    } catch (error) {
      if (!transient(error) || attempt >= 3) {
        throw new Error("Prediction finished, but results could not be loaded. Reselect this image to load its saved predictions.");
      }
      onStatus({ ...job, state: "running", message: "Loading saved prediction results…" });
      await pause();
    }
  }
}

export async function requestPrediction(
  imageId: string,
  modelId: string,
  onStatus: (status: PredictionStatus) => void,
): Promise<Doc> {
  const options = json({ model_id: modelId, request_id: crypto.randomUUID() });
  const url = `/api/images/${imageId}/prediction`;
  let job: PredictionStatus;
  try {
    job = await api<PredictionStatus>(url, options);
  } catch (error) {
    if (!transient(error)) throw error;
    onStatus({ state: "running", message: "Reconnecting to prediction request…" });
    await pause();
    // Reusing the ID makes retrying safe even if the first response was lost.
    job = await api<PredictionStatus>(url, options);
  }
  return followPrediction(imageId, job, onStatus);
}
