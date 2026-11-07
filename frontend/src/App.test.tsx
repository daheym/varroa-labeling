// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { Doc, SourceFocus, TileContext } from "./types";

vi.mock("./Canvas", () => ({ default: ({ doc, focusTarget, selected, tileContext, tilesVisible }: {
  doc: Doc; focusTarget: SourceFocus | null; selected: string | null; tileContext: TileContext | null; tilesVisible: boolean;
}) => <div data-testid="canvas" data-focus={JSON.stringify(focusTarget)} data-selected={selected}
  data-tiles={JSON.stringify(tileContext)} data-tiles-visible={tilesVisible}>{doc.image_id}</div> }));

const source: Doc = {
  schema_version: "1.0", image_id: "source-b", filename: "board.png",
  original_width: 1000, original_height: 1000, coordinate_space: "original",
  perspective: null, dataset_version: "test", model_version: null,
  review_complete: false, annotations: [], rejected_predictions: [], effort: {},
};
const items = Array.from({ length: 502 }, (_, index) => ({
  id: `prediction-${index}`, source_id: source.image_id, kind: "prediction",
  x: index, y: 100, crop: `${index}.png`, status: "extra", splits: ["val"],
  outcomes: [{ split: "val", status: "extra", tile_id: "val-tile" }],
  crop_bounds: { x: index - 48, y: 52, width: 96, height: 96 },
}));

let container: HTMLDivElement;
let root: Root;
let confirmed: Record<string, string>;
let runs: { id: string; name: string; ready: boolean }[];
let overviewLoads: string[];

function button(text: string) {
  const match = [...container.querySelectorAll("button")].find(el => el.textContent === text);
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}

function control(label: string) {
  const match = [...container.querySelectorAll("label")].find(el => el.textContent?.startsWith(label));
  const input = match?.querySelector("select, input");
  if (!(input instanceof HTMLSelectElement || input instanceof HTMLInputElement)) throw new Error(`Missing control: ${label}`);
  return input;
}

async function change(label: string, value: string) {
  await act(async () => {
    const input = control(label);
    // Use the native setter so React observes the change just as it does in the browser.
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(text: string) {
  await act(async () => { button(text).click(); });
}

beforeEach(async () => {
  source.annotations = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  confirmed = {};
  runs = [{ id: "latest", name: "Latest run", ready: true }, { id: "older", name: "Older run", ready: true }];
  overviewLoads = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    let data: unknown;
    if (url === "/api/images") data = [source];
    else if (url === "/api/normalization") data = { pixels_per_mm: 10, board_profiles: {} };
    else if (url === "/api/models") data = { models: [], status: "ready" };
    else if (url === "/api/models/train" || url.endsWith("/prediction")) data = { state: "idle", message: "" };
    else if (url === `/api/images/${source.image_id}`) data = source;
    else if (url === "/api/inspection/runs") data = runs;
    else if (url.startsWith("/api/inspection/runs/")) {
      overviewLoads.push(url);
      data = { run_name: "Test", interpretation: "", note: "", reviews: {},
        confirmed_predictions: confirmed, prediction_reviews: {}, annotation_states: {},
        items: [...items, { ...items[0], id: "other", source_id: "source-a" }],
        tile_layouts: { [source.image_id]: { width: 1000, height: 1000, coordinate_space: "original", homography: null, complete_grid: true, tiles: [
          { id: "val-tile", x: 0, y: 0, width: 640, height: 640, split: "val" },
          { id: "train-tile", x: 512, y: 0, width: 488, height: 640, split: "train" },
          { id: "omitted-tile", x: 0, y: 64, width: 640, height: 640, split: "omitted" },
        ] } } };
    } else throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<App />); });
  await click("Mite overview");
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe("Mite overview navigation", () => {
  it("toggles crop borders and carries the selected run's contributing tiles into the source view", async () => {
    expect(container.querySelector(".tile-crop-overlay")).toBeNull();
    expect(container.querySelector(".overview-heading-actions button")?.textContent).toBe("Show tile borders (T)");
    await click("Show tile borders (T)");
    expect(button("Hide tile borders (T)").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".tile-crop-overlay")?.getAttribute("viewBox")).toBe("-48 52 96 96");
    expect(container.querySelector('.tile-crop-overlay [data-usage="val"][data-contributing="true"] [stroke="#d8a3ff"]')).not.toBeNull();
    expect(container.querySelector('.tile-crop-overlay [data-usage="omitted"] [stroke-dasharray]')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>(".mite-card")!.click(); });
    expect(container.querySelector("dialog .tile-crop-overlay")).not.toBeNull();
    expect(container.querySelector("dialog")?.textContent).toContain("Training (0)");
    expect(container.querySelector("dialog")?.textContent).toContain("Validation (1)");
    expect(container.querySelector("dialog")?.textContent).toContain("Omitted from run (1)");
    await click("Open source image");
    const canvas = container.querySelector('[data-testid="canvas"]')!;
    expect(canvas.getAttribute("data-tiles-visible")).toBe("true");
    expect(JSON.parse(canvas.getAttribute("data-tiles")!)).toMatchObject({
      sourceId: source.image_id, runName: "Test", highlightedTileIds: ["val-tile"],
    });
    await click("Mite overview");
    await click("Hide tile borders (T)");
    expect(container.querySelector(".tile-crop-overlay")).toBeNull();
  });

  it("uses T in the overview, crop dialog and source view while ignoring typing, modifiers and repeats", async () => {
    async function pressT(target: EventTarget = document.body, options: KeyboardEventInit = {}) {
      await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "t", code: "KeyT", bubbles: true, cancelable: true, ...options,
      })); });
    }
    await pressT();
    expect(button("Hide tile borders (T)").getAttribute("aria-keyshortcuts")).toBe("T");
    for (const options of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      await pressT(document.body, options);
      expect(button("Hide tile borders (T)").getAttribute("aria-pressed")).toBe("true");
    }
    await pressT(control("Crop size"));
    await pressT(control("Training run"));
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.setAttribute("contenteditable", "true");
    editor.innerHTML = "<span>Editable text</span>";
    const textarea = document.createElement("textarea");
    container.append(editor, textarea);
    await pressT(editor.firstElementChild!);
    await pressT(textarea);
    expect(button("Hide tile borders (T)").getAttribute("aria-pressed")).toBe("true");
    editor.remove(); textarea.remove();
    await act(async () => { container.querySelector<HTMLButtonElement>(".mite-card")!.click(); });
    await pressT(container.querySelector("dialog")!);
    expect(container.querySelector("dialog .tile-crop-overlay")).toBeNull();
    expect(container.querySelector(".tile-crop-overlay")).toBeNull();
    const detailToggle = container.querySelector<HTMLButtonElement>('dialog button[aria-keyshortcuts="T"]')!;
    await act(async () => { detailToggle.click(); });
    expect(container.querySelector("dialog .tile-crop-overlay")).not.toBeNull();
    expect(container.querySelector('.overview-heading-actions button[aria-pressed="true"]')).not.toBeNull();
    await click("Open source image");
    await pressT();
    expect(container.querySelector('[data-testid="canvas"]')?.getAttribute("data-tiles-visible")).toBe("false");
    await click("Mite overview");
    expect(button("Show tile borders (T)").getAttribute("aria-pressed")).toBe("false");
  });
  it("passes an unmatched prediction location to the canvas without creating a label", async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>(".mite-card")!.click(); });
    await click("Open source image");
    const canvas = container.querySelector('[data-testid="canvas"]')!;
    expect(JSON.parse(canvas.getAttribute("data-focus")!)).toMatchObject({
      imageId: source.image_id, annotationId: null, x: 0, y: 100,
    });
    expect(canvas.getAttribute("data-selected")).toBeNull();
    expect(container.textContent).toContain("Located overview position at 0.0, 100.0");
    expect(source.annotations).toEqual([]);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/annotations"))).toBe(false);
  });

  it("still selects an existing label when opening its overview location", async () => {
    source.annotations = [{ id: "existing", x: 0, y: 100, className: "varroa", source: "human", reviewed: true }];
    await act(async () => { container.querySelector<HTMLButtonElement>(".mite-card")!.click(); });
    await click("Open source image");
    const canvas = container.querySelector('[data-testid="canvas"]')!;
    expect(JSON.parse(canvas.getAttribute("data-focus")!)).toMatchObject({ annotationId: "existing", x: 0, y: 100 });
    expect(canvas.getAttribute("data-selected")).toBe("existing");
  });

  it("preserves every overview setting and page after opening a source, while reloading current reviews", async () => {
    await change("Training run", "older");
    await change("Result", "extra");
    await change("Membership", "val");
    await change("Source image", "source-b");
    await change("Review status", "unreviewed");
    await change("Crop size", "128");
    await click("Next");
    expect(container.querySelectorAll(".mite-card")).toHaveLength(2);
    expect(container.querySelector(".overview-pagination")?.textContent).toContain("Page 2 / 2");
    await act(async () => { container.querySelector<HTMLButtonElement>(".mite-card")!.click(); });
    await click("Open source image");
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe("source-b");
    expect(container.querySelector(".mite-overview")).toBeNull();

    confirmed = { "prediction-0": "reviewed-label" };
    const loadsBeforeReturn = overviewLoads.length;
    await click("Mite overview");
    for (const [label, value] of Object.entries({
      "Training run": "older", Result: "extra", Membership: "val", "Source image": "source-b",
      "Review status": "unreviewed", "Crop size": "128",
    })) expect(control(label).value, label).toBe(value);
    expect(container.querySelector(".overview-pagination")?.textContent).toContain("501 of 503 crops");
    expect(container.querySelector(".overview-pagination")?.textContent).toContain("Page 2 / 2");
    expect(container.querySelectorAll(".mite-card")).toHaveLength(1);
    expect(overviewLoads.slice(loadsBeforeReturn)).toEqual(["/api/inspection/runs/older"]);
    expect(container.querySelector("dialog")?.open).toBe(false);

    await click("Annotate");
    await click("Mite overview");
    expect(control("Source image").value).toBe("source-b");
    expect(container.querySelector(".overview-pagination")?.textContent).toContain("Page 2 / 2");
    await change("Result", "errors");
    expect(container.querySelector(".overview-pagination")?.textContent).toContain("Page 1 / 2");
    await click("Next");
    await change("Training run", "latest");
    expect(control("Source image").value).toBe("");
    expect(container.querySelector(".overview-pagination")?.textContent).toContain("Page 1 / 2");
  });

  it("falls back to an available run if the selected run disappears while annotating", async () => {
    await change("Training run", "older");
    await change("Source image", "source-b");
    await change("Result", "extra");
    await click("Next");
    await click("Annotate");
    runs = runs.filter(run => run.id !== "older");
    await click("Mite overview");
    expect(control("Training run").value).toBe("latest");
    expect(control("Source image").value).toBe("");
    expect(control("Result").value).toBe("extra");
    expect(container.querySelector(".overview-pagination")?.textContent).toContain("Page 1 / 2");
  });
});
