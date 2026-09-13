import { useEffect, useRef, useState } from "react";
import Canvas from "./Canvas";
import type { Doc, ModelRegistry, Point } from "./types";

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const r = await fetch(url, options);
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.detail || `Request failed (${r.status})`);
  }
  return r.json();
}
const json = (data: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});
export default function App() {
  const [list, setList] = useState<Doc[]>([]),
    [doc, setDoc] = useState<Doc | null>(null),
    [selected, select] = useState<string | null>(null),
    [mode, setMode] = useState("manual"),
    [perspective, setPerspective] = useState(false),
    [corners, setCorners] = useState<Point[]>([]),
    [space, setSpace] = useState(false),
    [status, setStatus] = useState("Saved"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [corrected, setCorrected] = useState(false);
  const editable = corrected || doc?.coordinate_space === "original";
  const [exchangeDirectory, setExchangeDirectory] = useState("");
  const [exchangeVersion, setExchangeVersion] = useState("2026-09-12-001");
  const [reviewStats, setReviewStats] = useState<Record<string, number | string> | null>(null);
  const [trainedModels, setTrainedModels] = useState<ModelRegistry["models"]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelStatus, setModelStatus] = useState("loading");
  const [normalization, setNormalization] = useState<{pixels_per_mm: number; board_profiles: Record<string, {physical_width_mm: number; physical_height_mm: number}>}>();
  const [boardProfile, setBoardProfile] = useState("");
  const [widthMm, setWidthMm] = useState("");
  const [heightMm, setHeightMm] = useState("");
  const current = useRef<Doc | null>(null),
    past = useRef<Doc[]>([]),
    future = useRef<Doc[]>([]),
    pending = useRef<Doc | null>(null),
    writes = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    chain = useRef<Promise<void>>(Promise.resolve()),
    lastAction = useRef(Date.now());
  function show(d: Doc) {
    current.current = d;
    setDoc(d);
  }
  function flush(): Promise<void> {
    clearTimeout(timer.current);
    const next = pending.current;
    if (!next) return chain.current;
    pending.current = null;
    writes.current += 1;
    chain.current = chain.current
      .catch(() => {})
      .then(async () => {
        try {
          setStatus("Saving…");
          await api(
            `/api/images/${next.image_id}/annotations`,
            json(next, "PUT"),
          );
          if (!pending.current && writes.current === 1) setStatus("Saved");
        } catch (e) {
          if (!pending.current) pending.current = current.current;
          setStatus("Save failed — retry");
          throw e;
        } finally {
          writes.current -= 1;
        }
      });
    return chain.current;
  }
  function queue(d: Doc) {
    pending.current = d;
    setStatus("Unsaved");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush().catch((e) => setError(String(e)));
    }, 600);
  }
  function commit(d: Doc, action?: string) {
    if (!current.current) return;
    past.current.push(current.current);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    const elapsed = Math.min(60, (Date.now() - lastAction.current) / 1000);
    lastAction.current = Date.now();
    d = {
      ...d,
      review_complete: action ? false : d.review_complete,
      effort: {
        ...d.effort,
        active_seconds: d.effort.active_seconds + elapsed,
        ...(action ? { [action]: (d.effort[action] || 0) + 1 } : {}),
      },
    };
    show(d);
    queue(d);
  }
  function undo(redo = false) {
    const from = redo ? future : past,
      to = redo ? past : future;
    const previous = from.current.pop();
    if (!previous || !current.current) return;
    to.current.push(current.current);
    const key = redo ? "redo" : "undo";
    const restored = {
      ...previous,
      effort: {
        ...current.current.effort,
        [key]: (current.current.effort[key] || 0) + 1,
      },
    };
    show(restored);
    queue(restored);
    select(null);
  }
  function remove() {
    const d = current.current;
    if (!d || !selected || !(corrected || d.coordinate_space === "original")) return;
    const a = d.annotations.find((a) => a.id === selected);
    if (!a) return;
    commit(
      {
        ...d,
        annotations: d.annotations.filter((a) => a.id !== selected),
        rejected_predictions:
          a.source === "model"
            ? [...d.rejected_predictions, { ...a, reviewed: true }]
            : d.rejected_predictions,
      },
      "deletes",
    );
    select(null);
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function refreshModels() {
    const registry = await api<ModelRegistry>("/api/models");
    setTrainedModels(registry.models);
    setModelStatus(registry.status);
    setSelectedModel((currentModel) =>
      registry.models.some((model) => model.id === currentModel)
        ? currentModel
        : (registry.models[0]?.id || ""),
    );
  }
  async function load(id: string) {
    await flush();
    const d = await api<Doc>(`/api/images/${id}`);
    show(d);
    past.current = [];
    future.current = [];
    select(null);
    setCorners((d.perspective?.source_points || d.perspective?.source_corners || []).map(([x, y]) => ({x, y})));
    setBoardProfile(d.perspective?.board_profile || "");
    setWidthMm(String(d.perspective?.physical_width_mm || ""));
    setHeightMm(String(d.perspective?.physical_height_mm || ""));
    setCorrected(d.coordinate_space === "canonical");
    setPerspective(false);
    setReviewStats(null);
    lastAction.current = Date.now();
  }
  async function resetAnnotations(all: boolean) {
    if (all) {
      if (
        window.prompt(
          "Permanently reset annotations for ALL images? This clears human annotations, predictions, review records, model versions and effort statistics. Images and perspective corrections are kept. This cannot be undone. Type RESET ALL to continue.",
        ) !== "RESET ALL"
      )
        return;
    } else if (
      !current.current ||
      !window.confirm(
        `Permanently reset annotations for "${current.current.filename}"? Predictions, review records, model version and effort statistics will also be cleared. Images and perspective corrections are kept. This cannot be undone.`,
      )
    )
      return;
    await run(async () => {
      // Drain autosave before reset so an older snapshot cannot restore annotations.
      await flush();
      if (all) {
        await api(
          "/api/annotations/reset-all",
          json({ confirmation: "RESET ALL" }),
        );
        // Clear history immediately, even if the subsequent refresh fails.
        past.current = [];
        future.current = [];
        if (current.current)
          show({
            ...current.current,
            annotations: [],
            rejected_predictions: [],
            model_version: null,
            effort: Object.fromEntries(
              Object.keys(current.current.effort).map((k) => [k, 0]),
            ),
          });
      } else if (current.current) {
        show(
          await api<Doc>(
            `/api/images/${current.current.image_id}/annotations/reset`,
            { method: "POST" },
          ),
        );
        past.current = [];
        future.current = [];
      }
      select(null);
      lastAction.current = Date.now();
      setStatus("Saved");
      setList(await api<Doc[]>("/api/images"));
    });
  }
  useEffect(() => {
    api<typeof normalization>("/api/normalization").then(setNormalization).catch(e => setError(String(e)));
    void refreshModels().catch(e => setError(String(e)));
    api<Doc[]>("/api/images")
      .then(setList)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input,textarea,select")) return;
      if (e.code === "Space") {
        e.preventDefault();
        setSpace(true);
      }
      if (busy || !editable) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo(e.shiftKey);
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
    };
    const blur = () => setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  });
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (pending.current || writes.current > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [status]);
  const selectedAnnotation = doc?.annotations.find((a) => a.id === selected);
  const model = doc?.annotations.filter((a) => a.source === "model") || [];
  return (
    <main>
      <header>
        <h1>
          Varroa <span>dataset annotation</span>
        </h1>
        <span role="status">{busy ? "Working…" : status}</span>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await flush();
            })
          }
        >
          Save now
        </button>
      </header>
      {error && (
        <div role="alert" className="error">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      <div className="workspace">
        <aside>
          <label>
            Upload JPEG / PNG
            <input
              disabled={busy}
              type="file"
              accept="image/jpeg,image/png"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                void run(async () => {
                  await flush();
                  const form = new FormData();
                  form.append("file", f);
                  const d = await api<Doc>("/api/images", {
                    method: "POST",
                    body: form,
                  });
                  setList((l) => [...l, d]);
                  await load(d.image_id);
                });
                e.target.value = "";
              }}
            />
          </label>
          <label>
            Image
            <select
              value={doc?.image_id || ""}
              disabled={busy}
              onChange={(e) => void run(() => load(e.target.value))}
            >
              <option value="" disabled>
                Select an image
              </option>
              {list.map((d) => (
                <option key={d.image_id} value={d.image_id}>
                  {d.filename}
                </option>
              ))}
            </select>
          </label>
          {doc && (
            <>
              <p>
                {doc.original_width} × {doc.original_height} original pixels
              </p>
                <h2>Image view</h2>
                <button disabled={busy} aria-pressed={!corrected} onClick={() => {setCorrected(false); select(null); setPerspective(true);}}>Original</button>
                <button aria-pressed={corrected} disabled={busy || doc.coordinate_space !== "canonical"} onClick={() => {setCorrected(true); setPerspective(false); select(null);}}>Corrected</button>
                {doc.coordinate_space !== "canonical" && <p>Corrected annotations unavailable. Define the board dimensions and generate correction. Legacy points will be migrated.</p>}
                {doc.perspective?.quality_warning && <p role="alert">{doc.perspective.quality_warning}</p>}
              <label>
                Annotation mode
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="manual">Manual Mode</option>
                  <option value="review">Model Review Mode</option>
                </select>
              </label>
              <div className="count">
                {doc.annotations.length}
                <small>current annotations</small>
              </div>
              <div className="legend">
                ● Green: reviewed / human
                <br />◌ Blue: unreviewed model
                <br />○ White: selected
              </div>
              <fieldset disabled={busy}>
                <div className="buttons">
                  <button
                    disabled={!editable || !past.current.length}
                    onClick={() => undo()}
                  >
                    Undo
                  </button>
                  <button
                    disabled={!editable || !future.current.length}
                    onClick={() => undo(true)}
                  >
                    Redo
                  </button>
                </div>
                <button disabled={!editable || !selected} onClick={remove}>
                  Delete selected
                </button>
                {selectedAnnotation && (
                  <p>
                    Selected: {selectedAnnotation.x.toFixed(2)},{" "}
                    {selectedAnnotation.y.toFixed(2)}
                    <br />
                    {selectedAnnotation.source}
                    {selectedAnnotation.confidence != null
                      ? ` · ${(selectedAnnotation.confidence * 100).toFixed(1)}%`
                      : ""}
                  </p>
                )}
                {mode === "review" && editable && (
                  <>
                    <h2>Model review</h2>
                    <dl>
                      <dt>Total predictions</dt>
                      <dd>{model.length + doc.rejected_predictions.length}</dd>
                      <dt>Accepted</dt>
                      <dd>{model.filter((a) => a.reviewed).length}</dd>
                      <dt>Rejected</dt>
                      <dd>{doc.rejected_predictions.length}</dd>
                      <dt>Manually added</dt>
                      <dd>
                        {
                          doc.annotations.filter((a) => a.source === "human")
                            .length
                        }
                      </dd>
                    </dl>
                    <p>Model: {doc.model_version || "No prediction batch"}</p>
                    <label>
                      Import candidate JSON
                      <input
                        type="file"
                        accept="application/json,.json"
                        disabled={!!doc.model_version}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          void run(async () => {
                            const payload = JSON.parse(await f.text());
                            await flush();
                            const updated = await api<Doc>(
                              `/api/images/${doc.image_id}/candidates`,
                              json(payload),
                            );
                            show(updated);
                            past.current = [];
                            future.current = [];
                          });
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <label>
                      Trained model
                      <select
                        value={selectedModel}
                        disabled={!!doc.model_version || trainedModels.length === 0}
                        onChange={(e) => setSelectedModel(e.target.value)}
                      >
                        <option value="">Select a trained model</option>
                        {trainedModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="buttons">
                      <button
                        type="button"
                        onClick={() => void run(refreshModels)}
                      >
                        Refresh model list
                      </button>
                      <button
                        type="button"
                        disabled={!selectedModel || !!doc.model_version || doc.coordinate_space !== "canonical"}
                        onClick={() =>
                          void run(async () => {
                            await flush();
                            const updated = await api<Doc>(
                              `/api/images/${doc.image_id}/predict`,
                              json({ model_id: selectedModel }),
                            );
                            show(updated);
                            past.current = [];
                            future.current = [];
                            select(null);
                            setStatus("Predictions ready for review");
                          })
                        }
                      >
                        Request predictions
                      </button>
                    </div>
                    {trainedModels.length === 0 && modelStatus !== "loading" && (
                      <p role="status">
                        No compatible trained models found ({modelStatus}). Check the training repository and its model preprocessing files, then refresh.
                      </p>
                    )}
                    {doc.coordinate_space !== "canonical" && (
                      <p>Generate physical perspective correction before requesting predictions.</p>
                    )}
                    <button
                      disabled={
                        !selectedAnnotation || selectedAnnotation.reviewed
                      }
                      onClick={() =>
                        commit(
                          {
                            ...doc,
                            annotations: doc.annotations.map((a) =>
                              a.id === selected ? { ...a, reviewed: true } : a,
                            ),
                          },
                          "accepts",
                        )
                      }
                    >
                      Accept selected
                    </button>
                    <button
                      disabled={!doc.annotations.some((a) => !a.reviewed)}
                      onClick={() => {
                        const n = doc.annotations.filter(
                          (a) => !a.reviewed,
                        ).length;
                        commit({
                          ...doc,
                          annotations: doc.annotations.map((a) => ({
                            ...a,
                            reviewed: true,
                          })),
                          effort: {
                            ...doc.effort,
                            accepts: doc.effort.accepts + n,
                          },
                        });
                      }}
                    >
                      Mark all reviewed
                    </button>
                  </>
                )}
                <h2>Physical normalization</h2>
                <p>Scale: {normalization?.pixels_per_mm ?? "Loading"} pixels/mm</p>
                <label>Board profile<select value={boardProfile} onChange={e => {
                  setBoardProfile(e.target.value);
                  const profile = normalization?.board_profiles[e.target.value];
                  if (profile) {setWidthMm(String(profile.physical_width_mm)); setHeightMm(String(profile.physical_height_mm));}
                }}><option value="">Custom dimensions</option>{Object.keys(normalization?.board_profiles || {}).map(k => <option key={k}>{k}</option>)}</select></label>
                <label>Board width (mm)<input type="number" min="0.01" step="any" value={widthMm} onChange={e => {setWidthMm(e.target.value); setBoardProfile("");}} /></label>
                <label>Board height (mm)<input type="number" min="0.01" step="any" value={heightMm} onChange={e => {setHeightMm(e.target.value); setBoardProfile("");}} /></label>
                <h2>Perspective correction</h2>
                <label>
                  <input
                    type="checkbox"
                    checked={perspective}
                    onChange={(e) => {setPerspective(e.target.checked); setCorrected(false); select(null);}}
                  />{" "}
                  Place corners
                </label>
                {perspective && (
                  <>
                    <p>
                      Click in order: top-left, top-right, bottom-right,
                      bottom-left. Drag to refine.
                    </p>
                    <button onClick={() => setCorners([])}>
                      Reset corners
                    </button>
                    <button
                      disabled={corners.length !== 4 || !normalization || !(Number(widthMm) > 0) || !(Number(heightMm) > 0)}
                      onClick={() =>
                        void run(async () => {
                          await flush();
                          show(
                            await api<Doc>(
                              `/api/images/${doc.image_id}/perspective`,
                              json({ corners, board_profile: boardProfile || null, physical_width_mm: Number(widthMm), physical_height_mm: Number(heightMm) }),
                            ),
                          );
                          past.current = [];
                          future.current = [];
                          setCorrected(true); setPerspective(false); select(null);
                        })
                      }
                    >
                      Generate corrected image
                    </button>
                  </>
                )}
                {doc.perspective && (
                  <a
                    href={`/api/images/${doc.image_id}/corrected`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open corrected image ↗
                  </a>
                )}
                <h2>Dataset</h2>
                <label>
                  Dataset version
                  <input
                    value={doc.dataset_version}
                    onChange={(e) =>
                      commit({ ...doc, dataset_version: e.target.value })
                    }
                  />
                </label>
                <button
                  onClick={() =>
                    void run(async () => {
                      await flush();
                      const exported = await api<Doc>(
                        `/api/images/${doc.image_id}/export`,
                      );
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(exported, null, 2)], {
                          type: "application/json",
                        }),
                      );
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${doc.image_id}.ground-truth.json`;
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })
                  }
                >
                  Export reviewed ground truth
                </button>
                <p>
                  {doc.annotations.filter((a) => !a.reviewed).length} awaiting
                  review
                </p>
                <details>
                  <summary>Annotation effort</summary>
                  {Object.entries(doc.effort).map(([k, v]) => (
                    <div key={k}>
                      {k.replaceAll("_", " ")}: {Math.round(v)}
                    </div>
                  ))}
                </details>
              </fieldset>
            </>
          )}
          <h2>Dataset exchange</h2>
          <label>Linked folder (server path)<input value={exchangeDirectory} onChange={e => setExchangeDirectory(e.target.value)} placeholder="F:/ImkerApp/exports/dataset-v1" /></label>
          <label>Export version<input value={exchangeVersion} onChange={e => setExchangeVersion(e.target.value)} /></label>
          {doc && <>
            <button disabled={busy || doc.annotations.some(a => !a.reviewed)} onClick={() => void run(async () => {
              commit({...doc, review_complete: true}); await flush();
              setReviewStats(await api<Record<string, number | string>>(`/api/images/${doc.image_id}/review-statistics`));
            })}>Finish image review (including empty images)</button>
            <p>{doc.review_complete ? "Image review complete" : "Image review incomplete"}</p>
          </>}
          <button disabled={busy || !exchangeDirectory} onClick={() => void run(async () => {
            await flush();
            const documents = await api<Doc[]>("/api/images");
            await api("/api/exchange/export", json({directory: exchangeDirectory, dataset_version: exchangeVersion,
              purpose: "ground_truth", image_ids: documents.filter(d => d.review_complete).map(d => d.image_id)}));
            setStatus("Reviewed dataset exported");
          })}>Export completed images as ground truth</button>
          <button disabled={busy || !exchangeDirectory} onClick={() => void run(async () => {
            await flush();
            const documents = await api<Doc[]>("/api/images");
            await api("/api/exchange/export", json({directory: exchangeDirectory, dataset_version: exchangeVersion,
              purpose: "unreviewed", image_ids: documents.filter(d => !d.review_complete).map(d => d.image_id)}));
            setStatus("Unreviewed images exported for prediction");
          })}>Export unreviewed images for prediction</button>
          <button disabled={busy || !exchangeDirectory} onClick={() => void run(async () => {
            await flush();
            await api("/api/exchange/import", json({directory: exchangeDirectory}));
            setList(await api<Doc[]>("/api/images"));
            if (doc) await load(doc.image_id);
            setMode("review");
            setStatus("Predictions imported");
          })}>Import prediction directory</button>
          {reviewStats && <details open><summary>Review statistics</summary>{Object.entries(reviewStats).filter(([k]) => !["schema_version", "image_id"].includes(k)).map(([k,v]) => <div key={k}>{k.replaceAll("_", " ")}: {v}</div>)}</details>}
          <h2>Reset annotations</h2>
          <p>
            Permanent. Also clears prediction reviews and effort statistics.
            Keeps images and perspective corrections.
          </p>
          <button
            className="danger"
            disabled={busy || !doc}
            onClick={() => void resetAnnotations(false)}
          >
            Reset current image annotations
          </button>
          <button
            className="danger"
            disabled={busy || list.length === 0}
            onClick={() => void resetAnnotations(true)}
          >
            Reset ALL annotations…
          </button>
          <p className="help">
            Click to add · drag marker to correct
            <br />
            Wheel: zoom · Space + drag: pan
            <br />
            Ctrl/Cmd+Z: undo
            <br />
            Ctrl/Cmd+Shift+Z: redo
            <br />
            Delete/Backspace: delete
          </p>
        </aside>
        <section
          className="canvas-panel"
          style={{ pointerEvents: busy ? "none" : undefined }}
        >
          {doc ? (
            <Canvas
              doc={doc}
              selected={selected}
              select={select}
              space={space}
              perspective={perspective}
              corrected={corrected}
              corners={corners}
              setCorners={setCorners}
              add={(p) => {
                if (!editable) return;
                const a = {
                  ...p,
                  id: crypto.randomUUID(),
                  className: "varroa" as const,
                  source: "human" as const,
                  reviewed: true,
                };
                commit(
                  { ...doc, annotations: [...doc.annotations, a] },
                  "manual_adds",
                );
                select(a.id);
              }}
              move={(id, p) =>
                commit(
                  {
                    ...doc,
                    annotations: doc.annotations.map((a) =>
                      a.id === id ? { ...a, ...p, bbox: null, reviewed: true } : a,
                    ),
                  },
                  "moves",
                )
              }
            />
          ) : (
            <div className="empty">
              Upload or select an image to begin.
              <p>Images are stored locally at full resolution.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
