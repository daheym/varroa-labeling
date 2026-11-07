import { describe, expect, it } from "vitest";
import { outcomeStatus, predictionReviewStatus } from "./MiteOverview";

describe("inspection outcomes for overlapping splits", () => {
  it("keeps training misses out of the validation result filter", () => {
    const item = { outcomes: [
      { split: "train", status: "missed" }, { split: "val", status: "matched" },
    ] };
    expect(outcomeStatus(item, "")).toBe("mixed");
    expect(outcomeStatus(item, "train")).toBe("missed");
    expect(outcomeStatus(item, "val")).toBe("matched");
  });
  it("does not imply success when a split has never been evaluated", () => {
    expect(outcomeStatus({ outcomes: [{ split: "val", status: "matched" }] }, "train")).toBe("not_evaluated");
    expect(outcomeStatus({ outcomes: [] }, "")).toBe("not_evaluated");
  });
});

describe("prediction review queue", () => {
  const prediction = { id: "extra-1", kind: "prediction" };
  it("does not treat existing training annotations as unreviewed predictions", () => {
    expect(predictionReviewStatus({ id: "label-1", kind: "annotation" })).toBeNull();
    expect(predictionReviewStatus(prediction)).toBe("unreviewed");
  });
  it("shows the current label even if an older not-mite review mark exists", () => {
    const confirmed = { "extra-1": "nearby-label" };
    expect(predictionReviewStatus(prediction, confirmed)).toBe("mite");
    expect(predictionReviewStatus(prediction, confirmed, { "extra-1": { decision: "not_mite" } })).toBe("mite");
    expect(predictionReviewStatus(prediction, {}, { "extra-1": { decision: "not_mite" } })).toBe("not_mite");
    expect(predictionReviewStatus(prediction, {}, {})).toBe("unreviewed");
  });
});
