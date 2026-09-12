import { describe, it, expect } from "vitest";
import {
  screenToImage,
  imageToScreen,
  zoomAt,
  inside,
  clampPoint,
} from "./coordinates";
describe("original pixel coordinates", () => {
  it("round trips fractional pixels across pan, zoom and viewport offsets", () => {
    for (const scale of [0.01, 0.25, 1, 3, 32])
      for (const x of [-1700, 0, 982]) {
        const v = { x, y: 321.5, scale };
        const p = { x: 4031.25, y: 3023.75 };
        const q = screenToImage(imageToScreen(p, v), v);
        expect(q.x).toBeCloseTo(p.x, 8);
        expect(q.y).toBeCloseTo(p.y, 8);
      }
  });
  it("anchors wheel zoom at the pointer", () => {
    const v = { x: -450, y: 120, scale: 0.4 },
      p = { x: 811, y: 414 };
    const before = screenToImage(p, v);
    expect(screenToImage(p, zoomAt(p, v, 2))).toEqual(before);
  });
  it("uses CSS stage coordinates independent of device pixel ratio", () => {
    expect(
      screenToImage({ x: 300, y: 200 }, { x: 100, y: 50, scale: 0.5 }),
    ).toEqual({ x: 400, y: 300 });
  });
  it("excludes out-of-image clicks and clamps marker movement", () => {
    expect(inside({ x: 4032, y: 0 }, 4032, 3024)).toBe(false);
    expect(inside({ x: -1, y: 0 }, 4032, 3024)).toBe(false);
    expect(clampPoint({ x: -4, y: 4000 }, 4032, 3024)).toEqual({
      x: 0,
      y: 3023.999,
    });
  });
});
