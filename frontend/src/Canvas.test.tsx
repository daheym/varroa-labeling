// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Canvas from "./Canvas";
import { imageToScreen } from "./coordinates";
import type { Doc, SourceFocus, TileContext } from "./types";

vi.mock("react-konva", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Stage: ({ children, x, y, scaleX }: { children?: ReactNode; x: number; y: number; scaleX: number }) =>
      <div data-testid="stage" data-x={x} data-y={y} data-scale={scaleX}>{children}</div>,
    Layer: Container,
    Group: ({ name, listening, children }: { name: string; listening: boolean; children?: ReactNode }) =>
      <div data-testid={name} data-listening={String(listening)}>{children}</div>,
    Image: () => null, Circle: () => null, Line: () => null, Text: () => null, Shape: () => null,
    Rect: ({ x, y, width, height, dash, stroke }: { x: number; y: number; width: number; height: number; dash?: number[]; stroke?: string }) =>
      <div data-testid="tile-rect" data-window={JSON.stringify({ x, y, width, height })}
        data-stroke={stroke} data-dash={JSON.stringify(dash)} data-highlighted={stroke === "#ffd166"} />,
  };
});

const doc: Doc = {
  schema_version: "1.0", image_id: "large-board", filename: "board.png",
  original_width: 6000, original_height: 4000, coordinate_space: "original",
  perspective: null, dataset_version: "test", model_version: null,
  review_complete: true, annotations: [], rejected_predictions: [], effort: {},
};
const target: SourceFocus = {
  imageId: doc.image_id, annotationId: null, requestId: "first",
  x: 3148.674982881224, y: 2919.3778574532134,
};
let container: HTMLDivElement;
let root: Root;
let props: Parameters<typeof Canvas>[0];

async function render() {
  await act(async () => { root.render(<Canvas {...props} />); });
}

async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(el => el.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => { button.click(); });
}

function view() {
  const stage = container.querySelector<HTMLElement>('[data-testid="stage"]')!;
  return { x: Number(stage.dataset.x), y: Number(stage.dataset.y), scale: Number(stage.dataset.scale) };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("null", { headers: { "Content-Type": "application/json" } })));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = { doc, selected: null, select: vi.fn(), add: vi.fn(), move: vi.fn(), corners: [],
    setCorners: vi.fn(), perspective: false, space: false, corrected: false,
    annotationsVisible: true, toggleAnnotations: vi.fn(), focusTarget: target, clearFocus: vi.fn(),
    tilesVisible: false, toggleTiles: vi.fn(), tileContext: null };
});

describe("saved tile overlay", () => {
  const context: TileContext = { sourceId: doc.image_id, runName: "Reviewed run", highlightedTileIds: ["second"],
    layout: { width: 6000, height: 4000, coordinate_space: "original", homography: null, complete_grid: true, tiles: [
      { id: "first", x: 0, y: 0, width: 640, height: 640, split: "train" },
      { id: "second", x: 512, y: 0, width: 640, height: 640, split: "val" },
      { id: "omitted", x: 1024, y: 0, width: 640, height: 640, split: "omitted" },
    ] } };

  it("shows exact overlapping windows independently of annotations without changing the viewport", async () => {
    props = { ...props, tileContext: context, toggleTiles: vi.fn(() => { props = { ...props, tilesVisible: !props.tilesVisible }; }) };
    await render();
    const originalView = view();
    expect(container.querySelector('[data-testid="tile-borders"]')).toBeNull();
    await click("Show tile borders (T)");
    await render();
    expect(container.querySelector('[data-testid="tile-borders"]')?.getAttribute("data-listening")).toBe("false");
    expect(container.querySelectorAll('[data-testid="tile-rect"]')).toHaveLength(7);
    expect(container.querySelectorAll('[data-highlighted="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-stroke="#65deff"]')?.getAttribute("data-dash")).toBeNull();
    expect(container.querySelector('[data-stroke="#d8a3ff"]')?.getAttribute("data-dash")).toBeDefined();
    expect(container.querySelector('[data-stroke="#a9b4c2"]')?.getAttribute("data-dash")).toBeDefined();
    expect(container.textContent).toContain("Training (1)");
    expect(container.textContent).toContain("Validation (1)");
    expect(container.textContent).toContain("Omitted from run (1)");
    expect(view()).toEqual(originalView);
    props = { ...props, annotationsVisible: false };
    await render();
    expect(container.querySelector('[data-testid="tile-borders"]')).not.toBeNull();
    await click("Hide tile borders (T)");
    await render();
    expect(container.querySelector('[data-testid="tile-borders"]')).toBeNull();
    expect(props.add).not.toHaveBeenCalled();
    expect(props.move).not.toHaveBeenCalled();
  });

  it("loads the latest saved tiles for an image opened directly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(context))));
    props = { ...props, tilesVisible: true };
    await render();
    expect(fetch).toHaveBeenCalledWith(`/api/images/${doc.image_id}/tiles`, expect.anything());
    expect(container.querySelector('[data-testid="tile-borders"]')).not.toBeNull();
  });

  it("withholds geometry from a different coordinate space or a changed perspective", async () => {
    const homography = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    props = { ...props, tileContext: { ...context, layout: { ...context.layout, coordinate_space: "canonical", homography } },
      tilesVisible: true, doc: { ...doc, coordinate_space: "canonical",
        perspective: { width: 6000, height: 4000, file: "corrected.png", homography } } };
    await render();
    expect(container.querySelector('[data-testid="tile-borders"]')).toBeNull();
    props = { ...props, corrected: true };
    await render();
    expect(container.querySelector('[data-testid="tile-borders"]')).not.toBeNull();
    props = { ...props, doc: { ...props.doc, perspective: { ...props.doc.perspective!, homography: [[2, 0, 0], [0, 2, 0], [0, 0, 1]] } } };
    await render();
    expect(container.querySelector('[data-testid="tile-borders"]')).toBeNull();
    expect(container.textContent).toContain("Tile borders unavailable");
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe("overview location in source canvas", () => {
  it("zooms to an unlabeled point and renders a guide that cannot intercept image clicks", async () => {
    await render();
    expect(imageToScreen(target, view())).toEqual({ x: 400, y: 300 });
    expect(view().scale).toBe(1.875);
    expect(container.querySelector('[data-testid="overview-location-guide"]')?.getAttribute("data-listening")).toBe("false");
    expect(container.textContent).toContain("Overview location: 3148.7, 2919.4 · temporary orange guide");
    expect(props.add).not.toHaveBeenCalled();
    expect(props.move).not.toHaveBeenCalled();
    expect(doc.annotations).toEqual([]);

    await click("Original / Fit image · 188%");
    expect(view().scale).toBeLessThan(0.2);
    await click("Center overview location");
    expect(imageToScreen(target, view())).toEqual({ x: 400, y: 300 });
    await click("Clear location guide");
    expect(props.clearFocus).toHaveBeenCalledOnce();
    props = { ...props, focusTarget: null };
    await render();
    expect(container.querySelector('[data-testid="overview-location-guide"]')).toBeNull();
  });

  it("focuses another prediction in the same image and hides its guide with annotations", async () => {
    await render();
    const next = { ...target, x: 200, y: 300, requestId: "next" };
    props = { ...props, focusTarget: next, annotationsVisible: false };
    await render();
    expect(imageToScreen(next, view())).toEqual({ x: 400, y: 300 });
    expect(container.querySelector('[data-testid="overview-location-guide"]')).toBeNull();
    props = { ...props, annotationsVisible: true };
    await render();
    expect(container.querySelector('[data-testid="overview-location-guide"]')).not.toBeNull();
  });

  it("keeps existing labels selected without an extra guide and ignores another image's target", async () => {
    const annotation = { id: "label", x: target.x, y: target.y, className: "varroa" as const,
      source: "human" as const, reviewed: true };
    props = { ...props, doc: { ...doc, annotations: [annotation] }, selected: annotation.id,
      focusTarget: { ...target, annotationId: annotation.id } };
    await render();
    expect(imageToScreen(target, view())).toEqual({ x: 400, y: 300 });
    expect(container.textContent).toContain("Selected label: 3148.7, 2919.4");
    expect(container.querySelector('[data-testid="overview-location-guide"]')).toBeNull();
    props = { ...props, doc: { ...doc, image_id: "other-board" }, selected: null };
    await render();
    expect(view().scale).toBeLessThan(0.2);
    expect(container.textContent).not.toContain("Center overview location");
  });
});
