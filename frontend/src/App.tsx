import { useEffect, useRef, useState } from "react";
import Canvas from "./Canvas";
import type { Doc, ModelRegistry, Point, PredictionStatus, TrainingStatus } from "./types";
import { api, json } from "./api";
import { followPrediction, requestPrediction } from "./prediction";

type WorkflowStep = "image" | "prepare" | "annotate" | "finish" | "exchange" | "train";

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
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  const editable = corrected || doc?.coordinate_space === "original";
  const [exchangeDirectory, setExchangeDirectory] = useState("");
  const [exchangeVersion, setExchangeVersion] = useState("2026-09-12-001");
  const [reviewStats, setReviewStats] = useState<Record<string, number | string> | null>(null);
  const [activeWorkflowStep, setActiveWorkflowStep] = useState<WorkflowStep | null>("image");
  const [trainedModels, setTrainedModels] = useState<ModelRegistry["models"]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelStatus, setModelStatus] = useState("loading");
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | null>(null);
  const [predictionStatus, setPredictionStatus] = useState<PredictionStatus | null>(null);
  const [predictionSeconds, setPredictionSeconds] = useState(0);
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
    operationRunning = useRef(false),
    lastAction = useRef(Date.now());
  function show(d: Doc) {
    current.current = d;
    setDoc(d);
  }
  function toggleWorkflowStep(step: WorkflowStep, isOpen: boolean) {
    setActiveWorkflowStep((active) =>
      isOpen ? step : active === step ? null : active,
    );
  }
  function toggleAnnotations() {
    setAnnotationsVisible((visible) => !visible);
    select(null);
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
          const saved = await api<Doc>(
            `/api/images/${next.image_id}/annotations`,
            json(next, "PUT"),
          );
          setList((documents) =>
            documents.map((document) =>
              document.image_id === saved.image_id ? saved : document,
            ),
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
    if (!d || !selected || !annotationsVisible || !(corrected || d.coordinate_space === "original")) return;
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
    if (operationRunning.current) return;
    operationRunning.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      operationRunning.current = false;
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
    setPredictionStatus(null);
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
    setActiveWorkflowStep(
      d.review_complete
        ? "exchange"
        : d.coordinate_space === "canonical"
          ? "annotate"
          : "prepare",
    );
    lastAction.current = Date.now();
    const job = await api<PredictionStatus>(`/api/images/${id}/prediction`);
    if (job.state === "running") await receivePrediction(id, job);
  }
  async function receivePrediction(imageId: string, existing?: PredictionStatus) {
    const started_at = existing?.started_at || new Date().toISOString();
    setPredictionStatus({ state: "running", message: "Saving annotations before prediction…", started_at });
    setPredictionSeconds(0);
    try {
      await flush();
      const update = (job: PredictionStatus) => setPredictionStatus({ ...job, started_at: job.started_at || started_at });
      const updated = existing
        ? await followPrediction(imageId, existing, update)
        : await requestPrediction(imageId, selectedModel, update);
      show(updated);
      setList((items) => items.map((item) => item.image_id === imageId ? updated : item));
      past.current = [];
      future.current = [];
      select(null);
      const message = `${updated.annotations.filter((a) => a.source === "model").length} predictions ready for review`;
      setPredictionStatus({ state: "succeeded", message, started_at });
      setStatus(message);
    } catch (e) {
      setPredictionStatus({ state: "failed", message: e instanceof Error ? e.message : String(e), started_at });
      setStatus("Prediction failed");
      throw e;
    }
  }
  async function resetAnnotations(all: boolean) {
    if (all) {
      if (
        window.prompt(
          "Permanently reset ALL annotations? This clears human and model annotations, rejected predictions, review status, model provenance, and effort statistics for every image. Images, perspective corrections, and dataset versions are kept. This cannot be undone. Type RESET ALL to continue.",
        ) !== "RESET ALL"
      )
        return;
    } else if (
      !current.current ||
      !window.confirm(
        `Permanently reset annotations for "${current.current.filename}"? Human and model annotations, rejected predictions, review status, model provenance, and effort statistics will be cleared. Images, perspective corrections, and dataset version are kept. This cannot be undone.`,
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
        past.current = [];
        future.current = [];
        if (current.current) {
          show(await api<Doc>(`/api/images/${current.current.image_id}`));
        }
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
      setPredictionStatus(null);
      setReviewStats(null);
      setActiveWorkflowStep(current.current ? "annotate" : "image");
      lastAction.current = Date.now();
      setStatus("Saved");
      setList(await api<Doc[]>("/api/images"));
    });
  }
  async function refreshTrainingStatus() {
    setTrainingStatus(await api<TrainingStatus>("/api/models/train"));
  }
  async function deleteCurrentImage() {
    const image = current.current;
    if (
      !image ||
      !window.confirm(
        `Remove "${image.filename}" from this dataset? This permanently deletes its uploaded image, corrected copies, annotations, prediction records, and local review history. Previously exported bundles remain unchanged. This cannot be undone.`,
      )
    )
      return;

    await run(async () => {
      // Finish any queued save before the API removes this image's files.
      await flush();
      await api<{ deleted_image_id: string }>(
        `/api/images/${image.image_id}`,
        { method: "DELETE" },
      );
      current.current = null;
      setPredictionStatus(null);
      setDoc(null);
      pending.current = null;
      past.current = [];
      future.current = [];
      select(null);
      setList((items) => items.filter((item) => item.image_id !== image.image_id));
      setCorners([]);
      setBoardProfile("");
      setWidthMm("");
      setHeightMm("");
      setCorrected(false);
      setPerspective(false);
      setReviewStats(null);
      setMode("manual");
      setActiveWorkflowStep("image");
      lastAction.current = Date.now();
      setStatus("Image removed from dataset");
    });
  }
  useEffect(() => {
    api<typeof normalization>("/api/normalization").then(setNormalization).catch(e => setError(String(e)));
    void refreshModels().catch(e => setError(String(e)));
    void refreshTrainingStatus().catch(e => setError(String(e)));
    api<Doc[]>("/api/images")
      .then(setList)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    if (predictionStatus?.state !== "running" || !predictionStatus.started_at) return;
    const startedAt = Date.parse(predictionStatus.started_at);
    const tick = () => setPredictionSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [predictionStatus?.state, predictionStatus?.started_at]);
  useEffect(() => {
    if (trainingStatus?.state !== "running") return;
    const poll = window.setInterval(() => {
      void api<TrainingStatus>("/api/models/train")
        .then(async (next) => {
          setTrainingStatus(next);
          if (next.state === "succeeded") {
            await refreshModels();
            setStatus("Training complete — new model ready");
          } else if (next.state === "failed") {
            setStatus("Training failed");
          }
        })
        .catch((e) => setError(String(e)));
    }, 2500);
    return () => window.clearInterval(poll);
  }, [trainingStatus?.state]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return;
      if (
        e.code === "KeyH" && !e.ctrlKey && !e.metaKey && !e.altKey &&
        !e.repeat && !e.isComposing && doc && !busy
      ) {
        e.preventDefault();
        toggleAnnotations();
        return;
      }
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
        <span role="status">{busy ? predictionStatus?.state === "running" ? "Predicting…" : "Working…" : status}</span>
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
          <details
            className="workflow-step"
            open={activeWorkflowStep === "image"}
            onToggle={(e) =>
              toggleWorkflowStep("image", e.currentTarget.open)
            }
          >
            <summary>
              <span className="step-number">1</span>
              <span className="step-title">Choose image</span>
              <span className="step-status">
                {doc ? "Selected" : "Start here"}
              </span>
            </summary>
            <div className="workflow-content">
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
            </div>
          </details>
          {doc && (
            <>
              <details
                className="workflow-step"
                open={activeWorkflowStep === "prepare"}
                onToggle={(e) =>
                  toggleWorkflowStep("prepare", e.currentTarget.open)
                }
              >
                <summary>
                  <span className="step-number">2</span>
                  <span className="step-title">Prepare image</span>
                  <span className="step-status">
                    {doc.coordinate_space === "canonical" ? "Ready" : "Optional"}
                  </span>
                </summary>
                <div className="workflow-content">
              <p>
                {doc.original_width} x {doc.original_height} original pixels
              </p>
              <h3>Image view</h3>
              <div className="buttons">
                <button
                  disabled={busy}
                  aria-pressed={!corrected}
                  onClick={() => {
                    setCorrected(false);
                    setPerspective(false);
                    select(null);
                  }}
                >
                  Original
                </button>
                <button
                  aria-pressed={corrected}
                  disabled={busy || doc.coordinate_space !== "canonical"}
                  onClick={() => {
                    setCorrected(true);
                    setPerspective(false);
                    select(null);
                  }}
                >
                  Corrected
                </button>
              </div>
              <p>
                Original shows the uploaded photo. Corrected shows the
                perspective-adjusted board at the configured physical scale.
                Edit annotations in Corrected view when physical correction is
                available.
              </p>
              {doc.coordinate_space !== "canonical" && (
                <p>
                  This image still uses original-pixel coordinates. Generate a
                  correction to map existing annotations to the corrected image;
                  check their positions afterward.
                </p>
              )}
              {doc.perspective?.quality_warning && (
                <p role="alert">{doc.perspective.quality_warning}</p>
              )}

              <h3>Physical normalization</h3>
              <p>
                Scale: {normalization?.pixels_per_mm ?? "Loading"} pixels/mm.
                Board width and height describe the physical board boundary.
                Physical correction is required for model predictions; manual
                labels can also use original pixels.
              </p>
              <label>
                Board profile
                <select
                  value={boardProfile}
                  disabled={busy}
                  onChange={(e) => {
                    setBoardProfile(e.target.value);
                    const profile = normalization?.board_profiles[e.target.value];
                    if (profile) {
                      setWidthMm(String(profile.physical_width_mm));
                      setHeightMm(String(profile.physical_height_mm));
                    }
                  }}
                >
                  <option value="">Custom dimensions</option>
                  {Object.keys(normalization?.board_profiles || {}).map((key) => (
                    <option key={key}>{key}</option>
                  ))}
                </select>
              </label>
              <label>
                Board width (mm)
                <input
                  type="number"
                  min="0.01"
                  step="any"
                  value={widthMm}
                  disabled={busy}
                  onChange={(e) => {
                    setWidthMm(e.target.value);
                    setBoardProfile("");
                  }}
                />
              </label>
              <label>
                Board height (mm)
                <input
                  type="number"
                  min="0.01"
                  step="any"
                  value={heightMm}
                  disabled={busy}
                  onChange={(e) => {
                    setHeightMm(e.target.value);
                    setBoardProfile("");
                  }}
                />
              </label>

              <h3>Perspective correction</h3>
              <p>
                In the original view, mark the board boundary in top-left,
                top-right, bottom-right, bottom-left order. The top edge is the
                width; the right edge is the height. Click to place corners and
                drag to refine them.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={perspective}
                  disabled={busy}
                  onChange={(e) => {
                    setPerspective(e.target.checked);
                    setCorrected(false);
                    select(null);
                  }}
                />{" "}
                Place corners
              </label>
              {perspective && (
                <>
                  <button disabled={busy} onClick={() => setCorners([])}>
                    Clear corner points
                  </button>
                  <button
                    disabled={
                      busy ||
                      corners.length !== 4 ||
                      !normalization ||
                      !(Number(widthMm) > 0) ||
                      !(Number(heightMm) > 0)
                    }
                    onClick={() =>
                      void run(async () => {
                        await flush();
                        show(
                          await api<Doc>(
                            `/api/images/${doc.image_id}/perspective`,
                            json({
                              corners,
                              board_profile: boardProfile || null,
                              physical_width_mm: Number(widthMm),
                              physical_height_mm: Number(heightMm),
                            }),
                          ),
                        );
                        past.current = [];
                        future.current = [];
                        setCorrected(true);
                        setPerspective(false);
                        select(null);
                        setActiveWorkflowStep("annotate");
                      })
                    }
                  >
                    Generate corrected image
                  </button>
                  <p>
                    Corner edits are drafts until generation succeeds. This maps
                    existing annotations into corrected-image coordinates.
                  </p>
                </>
              )}
              {doc.perspective && (
                <a
                  href={`/api/images/${doc.image_id}/corrected`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open corrected image file
                </a>
              )}
                </div>
              </details>

              <details
                className="workflow-step"
                open={activeWorkflowStep === "annotate"}
                onToggle={(e) =>
                  toggleWorkflowStep("annotate", e.currentTarget.open)
                }
              >
                <summary>
                  <span className="step-number">3</span>
                  <span className="step-title">Annotate and review</span>
                  <span className="step-status">
                    {doc.annotations.length === 0
                      ? "To do"
                      : `${doc.annotations.length} labels`}
                  </span>
                </summary>
                <div className="workflow-content">
              <label>
                Annotation mode
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="manual">Manual mode</option>
                  <option value="review">Model review mode</option>
                </select>
              </label>
              <div className="count">
                {doc.annotations.length}
                <small>current annotations</small>
              </div>
              <div className="legend">
                Green: human or reviewed prediction
                <br />
                Blue: unreviewed prediction
                <br />
                White: selected annotation
              </div>
              <fieldset disabled={busy}>
                <p>
                  In an editable view, click the image to add a human annotation
                  and drag a marker to move it. Deleting a model marker rejects
                  that prediction.
                </p>
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
                    Type: {selectedAnnotation.source}
                    {selectedAnnotation.confidence != null
                      ? `; confidence ${(selectedAnnotation.confidence * 100).toFixed(1)}%`
                      : ""}
                  </p>
                )}
                {mode === "review" && editable && (
                  <>
                    <details className="sidebar-subsection" open>
                      <summary>Model review</summary>
                    <dl>
                      <dt>Total predictions</dt>
                      <dd>{model.length + doc.rejected_predictions.length}</dd>
                      <dt>Accepted</dt>
                      <dd>{model.filter((a) => a.reviewed).length}</dd>
                      <dt>Rejected</dt>
                      <dd>{doc.rejected_predictions.length}</dd>
                      <dt>Manually added</dt>
                      <dd>
                        {doc.annotations.filter((a) => a.source === "human").length}
                      </dd>
                    </dl>
                    <p>Prediction batch: {doc.model_version || "None"}</p>
                    <label>
                      Trained model
                      <select
                        value={selectedModel}
                        disabled={!!doc.model_version || trainedModels.length === 0}
                        onChange={(e) => setSelectedModel(e.target.value)}
                      >
                        <option value="">Select a trained model</option>
                        {trainedModels.map((trainedModel) => (
                          <option key={trainedModel.id} value={trainedModel.id}>
                            {trainedModel.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="buttons">
                      <button type="button" onClick={() => void run(refreshModels)}>
                        Refresh model list
                      </button>
                      <button
                        type="button"
                        disabled={
                          !selectedModel ||
                          !!doc.model_version ||
                          doc.coordinate_space !== "canonical"
                        }
                        onClick={() => void run(() => receivePrediction(doc.image_id))}
                      >
                        {predictionStatus?.state === "running" ? "Predicting…" : "Request predictions"}
                      </button>
                    </div>
                    {trainedModels.length === 0 && modelStatus !== "loading" && (
                      <p role="status">
                        No compatible trained models found ({modelStatus}). Check
                        the training repository and preprocessing files, then
                        refresh the list.
                      </p>
                    )}
                    {doc.coordinate_space !== "canonical" && (
                      <p>
                        Generate physical perspective correction before
                        requesting predictions.
                      </p>
                    )}
                    <button
                      disabled={!selectedAnnotation || selectedAnnotation.reviewed}
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
                      Accept selected prediction
                    </button>
                    <button
                      disabled={!doc.annotations.some((a) => !a.reviewed)}
                      onClick={() => {
                        const n = doc.annotations.filter((a) => !a.reviewed).length;
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
                      Accept all remaining predictions
                    </button>
                    <p>
                      Deleting an unreviewed prediction rejects it. Finish image
                      review separately after checking the whole image.
                    </p>
                    </details>
                  </>
                )}
                <p>
                  {doc.annotations.filter((a) => !a.reviewed).length} annotations
                  awaiting review
                </p>
                <details>
                  <summary>Annotation effort</summary>
                  {Object.entries(doc.effort).map(([key, value]) => (
                    <div key={key}>
                      {key.replaceAll("_", " ")}: {Math.round(value)}
                    </div>
                  ))}
                </details>
              </fieldset>
                </div>
              </details>
            </>
          )}
          {!doc && (
            <>
              <details
                className="workflow-step"
                open={activeWorkflowStep === "prepare"}
                onToggle={(e) =>
                  toggleWorkflowStep("prepare", e.currentTarget.open)
                }
              >
                <summary>
                  <span className="step-number">2</span>
                  <span className="step-title">Prepare image</span>
                  <span className="step-status">Waiting</span>
                </summary>
                <div className="workflow-content">
                  <p>Choose an image to configure its physical correction.</p>
                </div>
              </details>
              <details
                className="workflow-step"
                open={activeWorkflowStep === "annotate"}
                onToggle={(e) =>
                  toggleWorkflowStep("annotate", e.currentTarget.open)
                }
              >
                <summary>
                  <span className="step-number">3</span>
                  <span className="step-title">Annotate and review</span>
                  <span className="step-status">Waiting</span>
                </summary>
                <div className="workflow-content">
                  <p>Choose an image to start annotation.</p>
                </div>
              </details>
            </>
          )}
          <details
            className="workflow-step"
            open={activeWorkflowStep === "finish"}
            onToggle={(e) =>
              toggleWorkflowStep("finish", e.currentTarget.open)
            }
          >
            <summary>
              <span className="step-number">4</span>
              <span className="step-title">Finish image review</span>
              <span className="step-status">
                {!doc
                  ? "Waiting"
                  : doc.review_complete
                    ? "Complete"
                    : doc.annotations.some((annotation) => !annotation.reviewed)
                      ? `${doc.annotations.filter((annotation) => !annotation.reviewed).length} pending`
                      : "Ready"}
              </span>
            </summary>
            <div className="workflow-content">
              {doc ? (
                <>
                  <button
                    disabled={
                      busy ||
                      doc.review_complete ||
                      doc.annotations.some((annotation) => !annotation.reviewed)
                    }
                    onClick={() =>
                      void run(async () => {
                        commit({ ...doc, review_complete: true });
                        await flush();
                        setActiveWorkflowStep("exchange");
                        setReviewStats(
                          await api<Record<string, number | string>>(
                            `/api/images/${doc.image_id}/review-statistics`,
                          ),
                        );
                      })
                    }
                  >
                    Mark image review complete
                  </button>
                  <p>
                    Check the whole image before finishing. Empty images can be
                    marked complete and are valid negatives for training.
                  </p>
                  {reviewStats && (
                    <details open>
                      <summary>Review statistics</summary>
                      {Object.entries(reviewStats)
                        .filter(([key]) => !["schema_version", "image_id"].includes(key))
                        .map(([key, value]) => (
                          <div key={key}>{key.replaceAll("_", " ")}: {value}</div>
                        ))}
                    </details>
                  )}
                </>
              ) : (
                <p>Choose an image to begin.</p>
              )}
            </div>
          </details>

          <details
            className="workflow-step"
            open={activeWorkflowStep === "exchange"}
            onToggle={(e) =>
              toggleWorkflowStep("exchange", e.currentTarget.open)
            }
          >
            <summary>
              <span className="step-number">5</span>
              <span className="step-title">Exchange dataset</span>
              <span className="step-status">
                {exchangeDirectory ? "Folder set" : "Optional"}
              </span>
            </summary>
            <div className="workflow-content">
              <label>
                Folder path on API server
                <input
                  value={exchangeDirectory}
                  onChange={(e) => setExchangeDirectory(e.target.value)}
                  placeholder="F:/ImkerApp/exports/dataset-v1"
                />
              </label>
              <p>
                For exports, choose a new folder outside app data. For imports,
                choose an existing predictions folder. The API server accesses
                this path, not the browser.
              </p>
              <label>
                Export dataset version
                <input
                  value={exchangeVersion}
                  onChange={(e) => setExchangeVersion(e.target.value)}
                />
              </label>
              <p>
                Used for both exports. Imports ignore this setting.
              </p>
              <button
                disabled={busy || !exchangeDirectory}
                onClick={() =>
                  void run(async () => {
                    await flush();
                    const documents = await api<Doc[]>("/api/images");
                    await api(
                      "/api/exchange/export",
                      json({
                        directory: exchangeDirectory,
                        dataset_version: exchangeVersion,
                        purpose: "ground_truth",
                        image_ids: documents
                          .filter((image) => image.review_complete)
                          .map((image) => image.image_id),
                      }),
                    );
                    setStatus("Reviewed images exported for training");
                  })
                }
              >
                Export reviewed images for training
              </button>
              <p>
                Includes images marked complete after review, including empty
                images. These labels form the reviewed training set.
              </p>
              <button
                disabled={busy || !exchangeDirectory}
                onClick={() =>
                  void run(async () => {
                    await flush();
                    const documents = await api<Doc[]>("/api/images");
                    await api(
                      "/api/exchange/export",
                      json({
                        directory: exchangeDirectory,
                        dataset_version: exchangeVersion,
                        purpose: "unreviewed",
                        image_ids: documents
                          .filter(
                            (image) =>
                              !image.review_complete && image.model_version === null,
                          )
                          .map((image) => image.image_id),
                      }),
                    );
                    setStatus("Images exported for model prediction");
                  })
                }
              >
                Export images for model prediction
              </button>
              <p>
                Sends incomplete images without a prediction batch to the
                external model pipeline for inference.
              </p>
              <button
                disabled={busy || !exchangeDirectory}
                onClick={() =>
                  void run(async () => {
                    await flush();
                    await api(
                      "/api/exchange/import",
                      json({ directory: exchangeDirectory }),
                    );
                    setList(await api<Doc[]>("/api/images"));
                    if (doc) await load(doc.image_id);
                    setMode("review");
                    setActiveWorkflowStep("annotate");
                    setStatus("Model predictions imported for review");
                  })
                }
              >
                Import model predictions for review
              </button>
              <p>
                Reads an existing predictions folder with matching image IDs.
                Each image accepts one prediction batch until its annotations
                are reset.
              </p>
            </div>
          </details>

          <details
            className="workflow-step"
            open={activeWorkflowStep === "train"}
            onToggle={(e) => toggleWorkflowStep("train", e.currentTarget.open)}
          >
            <summary>
              <span className="step-number">6</span>
              <span className="step-title">Train model</span>
              <span className="step-status">
                {trainingStatus?.state === "running"
                  ? "Running"
                  : trainingStatus?.state === "succeeded"
                    ? "Complete"
                    : trainingStatus?.state === "failed"
                      ? "Failed"
                      : trainingStatus?.state === "unavailable"
                        ? "Unavailable"
                        : "Ready"}
              </span>
            </summary>
            <div className="workflow-content">
              <p>
                Starts the production training workflow in the sibling
                varroa-training repository. All images must have physical
                correction and be marked complete; empty completed images are
                included as negatives.
              </p>
              <button
                disabled={
                  busy ||
                  list.length === 0 ||
                  trainingStatus?.state === "running" ||
                  trainingStatus?.state === "unavailable"
                }
                onClick={() => {
                  if (
                    !window.confirm(
                      `Start production training with all ${list.length} dataset images? Training runs in the background and may take a while.`,
                    )
                  )
                    return;
                  void run(async () => {
                    await flush();
                    const documents = await api<Doc[]>("/api/images");
                    setList(documents);
                    const next = await api<TrainingStatus>("/api/models/train", {
                      method: "POST",
                    });
                    setTrainingStatus(next);
                    setActiveWorkflowStep("train");
                    setStatus("Training started in background");
                  });
                }}
              >
                Start training
              </button>
              <p role="status">
                {trainingStatus?.message || "Checking training availability…"}
              </p>
              {trainingStatus?.started_at && (
                <p>
                  Started: {new Date(trainingStatus.started_at).toLocaleString()}
                  {trainingStatus.finished_at && (
                    <>
                      <br />
                      Finished: {new Date(trainingStatus.finished_at).toLocaleString()}
                    </>
                  )}
                </p>
              )}
              {trainingStatus?.log_tail && (
                <details className="sidebar-subsection">
                  <summary>Training log</summary>
                  <pre className="training-log">{trainingStatus.log_tail}</pre>
                </details>
              )}
            </div>
          </details>

          <details className="sidebar-tools">
            <summary>More tools</summary>
            <div className="workflow-content">
              <details className="tool-section">
                <summary>Reset annotations</summary>
                <p>
                  Permanent and cannot be undone. Clears human and model
                  annotations, rejected predictions, review status, model
                  provenance, and effort statistics. Keeps uploaded images,
                  perspective corrections, and dataset version.
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
                  Reset ALL annotations...
                </button>
              </details>
              <details className="tool-section">
                <summary>Remove image from dataset</summary>
                <p>
                  Permanently removes the selected image, its uploaded and
                  corrected files, annotations, prediction records, and local
                  review history. Previously exported bundles are unchanged.
                </p>
                <button
                  className="danger"
                  disabled={busy || !doc}
                  onClick={() => void deleteCurrentImage()}
                >
                  Delete selected image from dataset
                </button>
              </details>
              <details className="tool-section">
                <summary>Keyboard shortcuts</summary>
                <p className="help">
                  Click image: add annotation
                  <br />
                  Drag marker: move annotation
                  <br />
                  Mouse wheel: zoom; Space + drag: pan
                  <br />
                  H: hide / show annotations
                  <br />
                  Ctrl/Cmd+Z: undo; Ctrl/Cmd+Shift+Z: redo
                  <br />
                  Delete/Backspace: delete selected
                </p>
              </details>
            </div>
          </details>
        </aside>
        <section
          className="canvas-panel"
          style={{ pointerEvents: busy ? "none" : undefined }}
        >
          {predictionStatus && (
            <div className={`prediction-status prediction-${predictionStatus.state}`} role="status" aria-live="polite">
              {predictionStatus.state !== "running" && (
                <button className="prediction-dismiss" aria-label="Dismiss prediction status" onClick={() => setPredictionStatus(null)}>×</button>
              )}
              <strong>{predictionStatus.state === "running" ? "Prediction in progress" : predictionStatus.state === "failed" ? "Prediction failed" : "Prediction complete"}</strong>
              <p>{predictionStatus.message}</p>
              {predictionStatus.state === "running" && (
                <>
                  <div className="prediction-activity" role="progressbar" aria-label="Prediction in progress"><span /></div>
                  <small aria-live="off">Elapsed: {Math.floor(predictionSeconds / 60)}:{String(predictionSeconds % 60).padStart(2, "0")}</small>
                </>
              )}
            </div>
          )}
          {doc ? (
            <Canvas
              doc={doc}
              selected={selected}
              select={select}
              space={space}
              perspective={perspective}
              corrected={corrected}
              annotationsVisible={annotationsVisible}
              toggleAnnotations={toggleAnnotations}
              corners={corners}
              setCorners={setCorners}
              add={(p) => {
                if (!editable || !annotationsVisible) return;
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
