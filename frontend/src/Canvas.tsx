import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Group, Image as KImage, Circle, Line, Text, Shape } from "react-konva";
import {
  screenToImage,
  zoomAt,
  inside,
  clampPoint,
  viewAroundPoint,
  type View,
} from "./coordinates";
import type { Doc, Point, SourceFocus } from "./types";
type Props = {
  doc: Doc;
  selected: string | null;
  select: (id: string | null) => void;
  add: (p: Point) => void;
  move: (id: string, p: Point) => void;
  corners: Point[];
  setCorners: (p: Point[]) => void;
  perspective: boolean;
  space: boolean;
  corrected: boolean;
  annotationsVisible: boolean;
  toggleAnnotations: () => void;
  focusTarget: SourceFocus | null;
  clearFocus: () => void;
};
export default function Canvas(p: Props) {
  const editable = p.corrected || p.doc.coordinate_space === "original";
  const width = p.corrected ? p.doc.perspective!.width : p.doc.original_width;
  const height = p.corrected ? p.doc.perspective!.height : p.doc.original_height;
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [image, setImage] = useState<HTMLImageElement>();
  const [error, setError] = useState("");
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const focusTarget = editable && p.focusTarget?.imageId === p.doc.image_id
    && inside(p.focusTarget, width, height) ? p.focusTarget : null;
  const fit = () => {
    const scale =
      Math.min(
        size.width / width,
        size.height / height,
      ) * 0.95;
    setView({
      scale,
      x: (size.width - width * scale) / 2,
      y: (size.height - height * scale) / 2,
    });
  };
  useEffect(() => {
    const el = container.current!;
    const observer = new ResizeObserver(([e]) =>
      setSize({ width: e.contentRect.width, height: e.contentRect.height }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    setImage(undefined);
    setError("");
    const img = new window.Image();
    img.onload = () => {
      if (active) setImage(img);
    };
    img.onerror = () => {
      if (active) setError("Image could not be decoded. Reload to retry.");
    };
    img.src = `/api/images/${p.doc.image_id}/${p.corrected ? `corrected?v=${p.doc.perspective!.file}` : "file"}`;
    return () => {
      active = false;
    };
  }, [p.doc.image_id, p.corrected, p.doc.perspective?.file]);
  useEffect(fit, [p.doc.image_id, width, height, p.corrected, size.width, size.height]);
  useEffect(() => {
    if (focusTarget) setView(viewAroundPoint(focusTarget, size));
  }, [focusTarget, size.width, size.height]);
  const selectedLabel = p.doc.annotations.find(a => a.id === p.selected);
  return (
    <div className="canvas-wrap" ref={container}>
      <div className="canvas-toolbar">
        <button
          type="button"
          aria-pressed={p.annotationsVisible}
          aria-keyshortcuts="H"
          title="Hide or show annotation markers (H)"
          onClick={p.toggleAnnotations}
        >
          {p.annotationsVisible ? "Hide annotations" : "Show annotations"} (H)
        </button>
        <button type="button" onClick={fit}>
          {p.corrected ? "Corrected" : "Original"} / Fit image · {Math.round(view.scale * 100)}%
        </button>
        {!p.annotationsVisible && (
          <span role="status">Annotations hidden — show to add or move labels</span>
        )}
        {p.annotationsVisible && selectedLabel && <span role="status">
          Selected label: {selectedLabel.x.toFixed(1)}, {selectedLabel.y.toFixed(1)} · {selectedLabel.reviewed ? "marked reviewed" : "awaiting review"}
        </span>}
        {focusTarget && <>
          <button type="button" onClick={() => setView(viewAroundPoint(focusTarget, size))}>Center overview location</button>
          {!focusTarget.annotationId && <>
            <span role="status">Overview location: {focusTarget.x.toFixed(1)}, {focusTarget.y.toFixed(1)} · temporary orange guide</span>
            <button type="button" onClick={p.clearFocus}>Clear location guide</button>
          </>}
        </>}
      </div>
      {!image && (
        <div className="canvas-message">
          {error || "Loading full-resolution image…"}
        </div>
      )}
      <Stage
        width={size.width}
        height={size.height}
        x={view.x}
        y={view.y}
        scaleX={view.scale}
        scaleY={view.scale}
        draggable={p.space}
        style={{ cursor: p.space ? "grab" : p.perspective || (editable && p.annotationsVisible) ? "crosshair" : "default" }}
        onDragEnd={(e) => {
          if (e.target === e.target.getStage())
            setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
        }}
        onWheel={(e) => {
          e.evt.preventDefault();
          const pos = e.target.getStage()?.getPointerPosition();
          if (pos)
            setView((v) =>
              zoomAt(
                pos,
                v,
                Math.max(
                  0.005,
                  Math.min(32, v.scale * Math.exp(-e.evt.deltaY * 0.0015)),
                ),
              ),
            );
        }}
        onClick={(e) => {
          if (p.space || e.evt.button !== 0 || !image) return;
          const stage = e.target.getStage()!;
          if (e.target !== stage && e.target.name() !== "photo") return;
          const pointer = stage.getPointerPosition();
          if (!pointer) return;
          const point = screenToImage(pointer, view);
          if (!inside(point, width, height))
            return;
          if (p.perspective) {
            if (p.corners.length < 4) p.setCorners([...p.corners, point]);
          } else if (editable && p.annotationsVisible) p.add(point);
        }}
      >
        <Layer>
          <KImage
            name="photo"
            image={image}
            width={width}
            height={height}
          />
        </Layer>
        <Layer>
          {editable && p.annotationsVisible &&
            p.doc.annotations.map((a) => (
              <Circle
                key={a.id}
                x={a.x}
                y={a.y}
                radius={(p.selected === a.id ? 9 : 6) / view.scale}
                stroke={
                  p.selected === a.id
                    ? "#fff"
                    : a.source === "model" && !a.reviewed
                      ? "#248cff"
                      : "#3ff3a2"
                }
                fill={
                  a.source === "model" && !a.reviewed
                    ? "#248cff30"
                    : "#3ff3a230"
                }
                strokeWidth={2 / view.scale}
                dash={
                  a.source === "model" && !a.reviewed
                    ? [3 / view.scale, 2 / view.scale]
                    : undefined
                }
                hitStrokeWidth={12 / view.scale}
                draggable={!p.space && !p.perspective}
                onClick={(e) => {
                  e.cancelBubble = true;
                  p.select(a.id);
                }}
                onDragStart={() => p.select(a.id)}
                onDragEnd={(e) => {
                  const pt = clampPoint(
                    e.target.position(),
                    width,
                    height,
                  );
                  e.target.position(pt);
                  p.move(a.id, pt);
                }}
              />
            ))}
          {focusTarget && !focusTarget.annotationId && p.annotationsVisible && <Group
            name="overview-location-guide" x={focusTarget.x} y={focusTarget.y} listening={false}
          >
            <Circle radius={14 / view.scale} stroke="#000" strokeWidth={5 / view.scale} />
            <Circle radius={14 / view.scale} stroke="#ffb347" strokeWidth={2 / view.scale} dash={[4 / view.scale, 3 / view.scale]} />
            {[[-24, 0, -17, 0], [17, 0, 24, 0], [0, -24, 0, -17], [0, 17, 0, 24]].map((segment, index) => <Line
              key={index} points={segment.map(value => value / view.scale)} stroke="#ffb347" strokeWidth={2 / view.scale}
            />)}
          </Group>}
          {!p.corrected && (
            <>
              {p.corners.length === 4 && <Shape listening={false} sceneFunc={(ctx, shape) => {
                ctx.beginPath(); ctx.rect(0, 0, width, height);
                const reversed = [...p.corners].reverse();
                ctx.moveTo(reversed[0].x, reversed[0].y);
                reversed.slice(1).forEach(c => ctx.lineTo(c.x, c.y));
                ctx.closePath(); ctx.fillStrokeShape(shape);
              }} fill="rgba(0,0,0,0.55)" />}
              <Line
                points={p.corners.flatMap((c) => [c.x, c.y])}
                closed={p.corners.length === 4}
                stroke="#62bdff"
                strokeWidth={2 / view.scale}
              />
              {p.corners.map((c, i) => (
                <Circle
                  key={i}
                  x={c.x}
                  y={c.y}
                  radius={9 / view.scale}
                  fill="#62bdff"
                  stroke="white"
                  strokeWidth={2 / view.scale}
                  draggable={!p.space}
                  onDragEnd={(e) => {
                    const pt = clampPoint(
                      e.target.position(),
                      width,
                      height,
                    );
                    e.target.position(pt);
                    p.setCorners(p.corners.map((q, j) => (j === i ? pt : q)));
                  }}
                />
              ))}
              {p.corners.map((c, i) => (
                <Text
                  key={i}
                  x={c.x + 12 / view.scale}
                  y={c.y}
                  text={String(i + 1)}
                  fill="white"
                  fontSize={16 / view.scale}
                  listening={false}
                />
              ))}
            </>
          )}
        </Layer>
      </Stage>
    </div>
  );
}
