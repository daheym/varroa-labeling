import type { Point } from "./types";
export type View = Point & { scale: number };
export function screenToImage(p: Point, v: View): Point {
  return { x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale };
}
export function imageToScreen(p: Point, v: View): Point {
  return { x: p.x * v.scale + v.x, y: p.y * v.scale + v.y };
}
export function zoomAt(p: Point, v: View, scale: number): View {
  const a = screenToImage(p, v);
  return { scale, x: p.x - a.x * scale, y: p.y - a.y * scale };
}
export function inside(p: Point, w: number, h: number) {
  return p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
}
export function clampPoint(p: Point, w: number, h: number): Point {
  return {
    x: Math.max(0, Math.min(w - 0.001, p.x)),
    y: Math.max(0, Math.min(h - 0.001, p.y)),
  };
}
