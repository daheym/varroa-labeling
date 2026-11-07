import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api, json } from "./api";
import type { Doc } from "./types";

type Outcome = { split: string; status: string; tile_id?: string; confidence?: number };
type Item = { id: string; source_id: string; kind: string; x: number; y: number; crop: string;
  status: string; splits: string[]; outcomes: Outcome[]; review_key?: string };
type Review = { reason: "not_mite" | "poor_quality" };
type AnnotationState = { status: "present" | "removed" | "changed" | "unavailable";
  annotation_id: string | null; can_restore: boolean };
type PredictionReview = { decision: "not_mite" };
type Overview = { run_name: string; interpretation: string; note: string; items: Item[]; reviews: Record<string, Review>;
  confirmed_predictions: Record<string, string>; prediction_reviews: Record<string, PredictionReview>;
  annotation_states: Record<string, AnnotationState> };
type Run = { id: string; name: string; ready: boolean };
const names: Record<string, string> = { matched: "Matched", missed: "Missed", mixed: "Mixed outcomes",
  extra: "Unmatched prediction", not_evaluated: "Not evaluated" };
const resultHelp: Record<string, { color: string; meaning: string; action: string }> = {
  matched: {
    color: "Green",
    meaning: "An existing mite label has a prediction matched to it within the run’s distance tolerance. None of its evaluated tile outcomes in the selected membership missed it.",
    action: "Keep the label if it is a real mite. A match only means the model agrees with the saved label; both can still be wrong.",
  },
  missed: {
    color: "Red",
    meaning: "This crop already has a mite label, but no prediction matched it in any of its evaluated tile outcomes in the selected membership.",
    action: "If it is a real mite, keep its existing label for future training. If it is not a mite, remove the label here. Correct misplaced labels in the source image.",
  },
  mixed: {
    color: "Purple",
    meaning: "The same labeled mite was matched in some tiles and missed in others. Overlapping tiles can show different context or put the mite near a tile edge.",
    action: "Open the crop to compare individual tile outcomes. The membership filter recalculates this category using only training or validation outcomes when selected.",
  },
  extra: {
    color: "Orange",
    meaning: "The model predicted an object that could not be paired with an existing label in that evaluated tile. Each prediction and label can be matched only once.",
    action: "It may be a mite missed during labeling, a false detection, or an extra detection near an already labeled mite. Use Confirm mite — add label if it is real and missing, or inspect the source image.",
  },
  not_evaluated: {
    color: "Gray",
    meaning: "No saved prediction outcome is available for this crop in the selected membership. Older runs often lack training-tile predictions; some annotations may not belong to any retained tile.",
    action: "There is no success or failure judgment here. This does not mean the crop was rejected, is not a mite, or was excluded from training.",
  },
};
const membershipHelp: Record<string, string> = {
  "": "An annotation can appear in both training and validation because tiles overlap. With All splits selected, its result combines all saved outcomes.",
  train: "Used for training means at least one retained training tile contained this label or prediction location. Results on these tiles measure reconstruction of training content, not performance on unseen photographs.",
  val: "Validation means at least one retained validation tile contained this label or prediction location. Overlapping training tiles can share image content, so this is not an independent test on unseen photographs.",
};

export function outcomeStatus(item: { outcomes: Outcome[] }, split: string) {
  const values = new Set(item.outcomes.filter(o => !split || o.split === split).map(o => o.status));
  return values.has("missed") && values.has("matched") ? "mixed" : values.has("missed") ? "missed"
    : values.has("extra") ? "extra" : values.has("matched") ? "matched" : "not_evaluated";
}

export function predictionReviewStatus(item: { id: string; kind: string },
  confirmed: Record<string, string> = {}, reviews: Record<string, PredictionReview> = {}) {
  if (item.kind !== "prediction") return null;
  if (confirmed[item.id]) return "mite";
  return reviews[item.id]?.decision === "not_mite" ? "not_mite" : "unreviewed";
}

export default function MiteOverview({ openSource, documentUpdated, savingChanged, refreshKey }: {
  openSource: (item: { source_id: string; x: number; y: number }) => void;
  documentUpdated: (doc: Doc, annotationId: string | null) => void;
  savingChanged: (saving: boolean) => void; refreshKey?: string;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState("");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState("");
  const [split, setSplit] = useState("");
  const [source, setSource] = useState("");
  const [quality, setQuality] = useState("");
  const [size, setSize] = useState(88);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Item | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const currentRun = runs.find(run => run.id === runId);
  useEffect(() => { savingChanged(saving); }, [saving, savingChanged]);
  useEffect(() => {
    const controller = new AbortController();
    api<Run[]>("/api/inspection/runs", { signal: controller.signal }).then(next => {
      setRuns(next);
      setRunId(previous => next.some(run => run.id === previous) ? previous : next[0]?.id || "");
    }).catch(e => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [revision, refreshKey]);
  useEffect(() => {
    setData(null); setSelected(null); setConfirmRemoval(false); setPage(0); setSource(""); setError(""); setNotice("");
    if (!runId || !currentRun?.ready) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    api<Overview>(`/api/inspection/runs/${runId}`, { signal: controller.signal }).then(setData)
      .catch(e => { if (!controller.signal.aborted) setError(String(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [runId, currentRun?.ready, revision]);
  useEffect(() => {
    if (selected && !dialog.current?.open) dialog.current?.showModal();
    if (!selected && dialog.current?.open) dialog.current?.close();
  }, [selected]);
  const matchingItems = useMemo(() => (data?.items || []).filter(item => {
    const status = outcomeStatus(item, split);
    return (!split || item.splits.includes(split)) && (!source || item.source_id === source)
      && (!result || (result === "errors" ? ["missed", "extra", "mixed"].includes(status) : result === status));
  }), [data, split, source, result]);
  const filtered = useMemo(() => matchingItems.filter(item => {
    const annotationStatus = data?.annotation_states[item.id]?.status;
    const reviewStatus = predictionReviewStatus(item, data?.confirmed_predictions, data?.prediction_reviews);
    if (quality === "unreviewed") return reviewStatus === "unreviewed";
    if (quality === "reviewed") return reviewStatus === "mite" || reviewStatus === "not_mite";
    if (quality === "not_mite") return reviewStatus === "not_mite";
    if (quality === "confirmed") return reviewStatus === "mite";
    if (quality === "removed") return annotationStatus === "removed";
    if (quality === "present") return annotationStatus === "present";
    if (quality === "legacy") return Boolean(item.review_key && data?.reviews[item.review_key]) && annotationStatus === "present";
    return !quality;
  }), [data, matchingItems, quality]);
  const predictionProgress = useMemo(() => matchingItems.reduce((progress, item) => {
    const status = predictionReviewStatus(item, data?.confirmed_predictions, data?.prediction_reviews);
    if (status !== null) {
      progress.total += 1;
      if (status !== "unreviewed") progress.reviewed += 1;
    }
    return progress;
  }, { total: 0, reviewed: 0 }), [data, matchingItems]);
  const sources = useMemo(() => [...new Set(data?.items.map(item => item.source_id) || [])], [data]);
  const pages = Math.max(1, Math.ceil(filtered.length / 500));
  const visiblePage = Math.min(page, pages - 1);
  const imageUrl = (item: Item) => `/api/inspection/runs/${runId}/crops/${encodeURIComponent(item.crop.split("/").pop()!)}`;
  async function build() {
    setLoading(true); setError("");
    try {
      await api(`/api/inspection/runs/${runId}/build`, { method: "POST" });
      setRevision(value => value + 1);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }
  async function review(reason: "not_mite" | null) {
    if (!selected?.review_key || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await api<{ document: Doc; annotation_id: string | null; message: string;
        annotation_states: Record<string, AnnotationState>; confirmed_predictions: Record<string, string> }>("/api/inspection/review",
        json({ run_id: runId, item_id: selected.id, reason,
          expected_annotation_id: data?.annotation_states[selected.id]?.annotation_id || null }, "PUT"));
      documentUpdated(response.document, response.annotation_id);
      setData(previous => previous ? { ...previous, annotation_states: response.annotation_states,
        confirmed_predictions: response.confirmed_predictions } : previous);
      setConfirmRemoval(false);
      setNotice(response.message);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  async function confirmMite() {
    if (!selected || selected.kind !== "prediction" || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await api<{ document: Doc; annotation_id: string; confirmed_predictions: Record<string, string>;
        prediction_reviews: Record<string, PredictionReview>; annotation_states: Record<string, AnnotationState>; message: string }>(
        "/api/inspection/confirm-mite", json({ run_id: runId, item_id: selected.id }));
      documentUpdated(response.document, response.annotation_id);
      setData(previous => previous ? { ...previous, confirmed_predictions: response.confirmed_predictions,
        prediction_reviews: response.prediction_reviews, annotation_states: response.annotation_states } : previous);
      setNotice(response.message);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  async function reviewPrediction(decision: "not_mite" | null) {
    if (!selected || selected.kind !== "prediction" || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await api<{ prediction_reviews: Record<string, PredictionReview>; document: Doc | null;
        annotation_id: string | null; annotation_states: Record<string, AnnotationState>; confirmed_predictions: Record<string, string> }>(
        "/api/inspection/prediction-review", json({ run_id: runId, item_id: selected.id, decision,
          expected_annotation_id: data?.confirmed_predictions[selected.id] || null }, "PUT"));
      if (response.document) documentUpdated(response.document, response.annotation_id);
      setData(previous => previous ? { ...previous, prediction_reviews: response.prediction_reviews,
        annotation_states: response.annotation_states, confirmed_predictions: response.confirmed_predictions } : previous);
      setConfirmRemoval(false);
      setNotice(decision ? response.document ? "Label removed from the training data. Nearby labels and tiles are unchanged."
        : "Reviewed: not a mite. This prediction has no label to remove."
        : "Review mark cleared. Any existing mite label is unchanged.");
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  const selectedReview = selected?.review_key ? data?.reviews[selected.review_key] : undefined;
  const selectedAnnotation = selected ? data?.annotation_states[selected.id] : undefined;
  const selectedPredictionStatus = selected ? predictionReviewStatus(selected, data?.confirmed_predictions, data?.prediction_reviews) : null;
  const selectedConfirmed = selectedPredictionStatus === "mite";
  return <section className="mite-overview" aria-label="Mite overview">
    <div className="overview-heading"><div><h2>Mite overview</h2><p>Inspect individual mites across a training run. Click any crop to review and update its current label.</p></div>
      <button disabled={loading || saving} onClick={() => setRevision(value => value + 1)}>Refresh runs</button></div>
    <div className="overview-controls">
      <label className="run-select">Training run<select value={runId} disabled={loading || saving} onChange={e => setRunId(e.target.value)}>
        {runs.map(run => <option key={run.id} value={run.id}>{run.name}{run.ready ? "" : " (overview not built)"}</option>)}
      </select></label>
      <label>Result<select value={result} aria-describedby="overview-filter-help" onChange={e => { setResult(e.target.value); setPage(0); }}>
        <option value="">All results</option><option value="errors">Discrepancies only</option>
        {Object.entries(names).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Membership<select value={split} aria-describedby="overview-membership-help" onChange={e => { setSplit(e.target.value); setPage(0); }}>
        <option value="">All splits</option><option value="train">Used for training</option><option value="val">Validation</option>
      </select></label>
      <label>Source image<select value={source} onChange={e => { setSource(e.target.value); setPage(0); }}>
        <option value="">All images</option>{sources.map(id => <option key={id}>{id}</option>)}
      </select></label>
      <label>Review status<select value={quality} aria-describedby="overview-review-help" onChange={e => { setQuality(e.target.value); setPage(0); }}>
        <option value="">All crops</option><option value="unreviewed">Unreviewed predictions</option>
        <option value="reviewed">Reviewed predictions</option><option value="not_mite">Reviewed: not a mite</option>
        <option value="confirmed">Confirmed mites from predictions</option><option value="removed">Removed labels</option>
        <option value="present">Current mite labels</option><option value="legacy">Legacy flags — review labels</option>
      </select></label>
      <label>Crop size: {size}px<input type="range" min="64" max="160" step="8" value={size} onChange={e => setSize(Number(e.target.value))} /></label>
    </div>
    <div className="overview-filter-help">
      <p id="overview-filter-help">{resultHelp[result]?.meaning || (result === "errors"
        ? "Discrepancies only shows Missed, Mixed outcomes, and Unmatched prediction. These are disagreements with the saved labels and may reveal either model errors or labeling mistakes."
        : "Result colors compare the model’s saved predictions with the labels used in that run. A disagreement can reveal a missed mite, an incorrect label, or a model mistake.")}</p>
      <p id="overview-membership-help">{membershipHelp[split]}</p>
      <p id="overview-review-help">{quality === "unreviewed"
        ? "Only unmatched predictions without a reviewed mite label nearby and without a Not a mite review mark. Review each crop, then confirm the mite or mark it Not a mite."
        : quality === "reviewed"
          ? "Unmatched predictions that have a reviewed mite label nearby or were marked Reviewed: not a mite. The result colors still describe the saved run."
          : quality === "not_mite"
            ? "These unmatched predictions were checked and marked Not a mite. No current reviewed label is linked to them, and no tiles are excluded."
        : quality === "confirmed"
        ? "✓ A reviewed mite label currently exists near this prediction. It may have been added with Confirm mite or already existed; the saved result color stays unchanged."
        : quality === "removed"
          ? "× No current label exists at these saved annotation centers. Removing a label keeps nearby mites and image tiles available for training."
          : quality === "present"
            ? "These saved annotation centers currently have a mite label in the dataset."
          : quality === "legacy"
            ? "These older flags still have current labels. Legacy flags no longer exclude tiles. Review each label and choose Not a mite — remove label if it is incorrect."
            : "Review badges describe the current labels and review decisions. They are separate from the result colors recorded by the selected run."}</p>
    </div>
    <details className="overview-category-guide">
      <summary>Category guide — result colors, membership, and review actions</summary>
      <div className="category-guide-content">
        <h3>What the result colors mean</h3>
        <p>Each labeled mite appears once in the grid, with its evaluated tile outcomes combined. Unmatched prediction crops belong to individual detections and may repeat across overlapping tiles.</p>
        <div className="category-guide-table"><table>
          <thead><tr><th scope="col">Category</th><th scope="col">Meaning</th><th scope="col">What to check</th></tr></thead>
          <tbody>{Object.entries(resultHelp).map(([value, help]) => <tr key={value}>
            <th scope="row"><span className={`legend-${value}`}>{help.color} — {names[value]}</span></th>
            <td>{help.meaning}</td><td>{help.action}</td>
          </tr>)}</tbody>
        </table></div>
        <div className="category-guide-columns">
          <section aria-label="Membership explained"><h3>Where was the crop used?</h3><dl>
            <dt>train — Used for training</dt><dd>The crop appeared in a retained tile used to fit the model. Its prediction outcomes are training reconstruction diagnostics.</dd>
            <dt>val — Validation</dt><dd>The crop appeared in a retained validation tile. These outcomes contribute to validation evaluation.</dd>
            <dt>train + val</dt><dd>Overlapping tiles put the same location in both groups. These are not fully independent views of the object. Use the membership filter to inspect each group separately.</dd>
            <dt>Unused</dt><dd>No retained training or validation tile contains this annotation in the selected run.</dd>
          </dl></section>
          <section aria-label="Review badges explained"><h3>What do the review badges mean?</h3><dl>
            <dt>✓ Confirmed mite</dt><dd>A currently reviewed mite label exists near an unmatched prediction. Several overlapping predictions can refer to the same label. The check does not change the historical result color.</dd>
            <dt>− Reviewed: not a mite</dt><dd>You checked this unmatched prediction and decided it is not a mite. No current reviewed label is linked to it. Repeated views from overlapping tiles can be reviewed separately.</dd>
            <dt>Unreviewed predictions</dt><dd>These unmatched predictions have neither a nearby reviewed mite label nor a Not a mite review mark. Use this filter to work through the remaining predictions.</dd>
            <dt>× Removed label</dt><dd>The saved annotation center no longer has a label in the current dataset. The image area remains available as background, and nearby mite labels are unchanged. The crop remains here as part of the saved run.</dd>
            <dt>Legacy flags</dt><dd>Old quality flags are shown for review and no longer exclude tiles. A legacy flag does not mean the label was removed.</dd>
          </dl></section>
          <section aria-label="Review actions explained"><h3>What changes when I review?</h3><dl>
            <dt>Confirm mite — add label</dt><dd>For an unmatched prediction, saves a reviewed mite label at the prediction center or reuses a nearby label to prevent duplicates. Adding or accepting a label reopens source image review; mark it complete before training.</dd>
            <dt>Mark reviewed: not a mite</dt><dd>For an unmatched prediction without a label, records that you checked and rejected the detection. If a current reviewed label is linked to the prediction, Not a mite offers a confirmation to delete that one label. Clearing a review mark does not restore a deleted label; use Confirm mite to add it again.</dd>
            <dt>Not a mite — remove label</dt><dd>After confirmation, removes only the current annotation at this crop center. An already completed image review stays complete. Restore label reverses a removal made here.</dd>
            <dt>Saved run results</dt><dd>Colors and scores describe the labels and predictions at the time of the run. Current label badges reflect the dataset now; historical colors and scores remain unchanged.</dd>
            <dt>Confidence</dt><dd>The percentage is the model’s detection score. It is separate from your review and is not a guarantee that the object is a mite.</dd>
          </dl></section>
        </div>
      </div>
    </details>
    {error && <p role="alert" className="error">{error}</p>}
    {loading && <p role="status">Loading overview…</p>}
    {!runs.length && !loading && <p>No completed run with saved point evaluation found. Complete a training run in Varroa Training, then refresh.</p>}
    {currentRun && !currentRun.ready && <div className="overview-notice"><p>This older run has no crop overview yet. Build it from its saved predictions. Training-only crops may be marked “not evaluated”.</p><button disabled={loading} onClick={() => void build()}>Build saved overview</button></div>}
    {data && <>
      <p className="overview-note">{data.interpretation} {data.note}</p>
      <p className="overview-note">Not a mite removes the selected annotation directly from the current dataset after confirmation. Nearby labels and tiles stay available for training. Saved run results stay as recorded.</p>
      <div className="overview-legend">{Object.entries(names).map(([value, label]) => <span key={value} className={`legend-${value}`} title={resultHelp[value].meaning}>{label}</span>)}<span title="A reviewed mite label currently exists near this prediction; the historical result color is unchanged.">✓ Confirmed mite</span><span title="This prediction was checked and marked Not a mite.">− Reviewed: not a mite</span><span title="No current label remains at this saved annotation center.">× Removed label</span></div>
      {predictionProgress.total > 0 && <p className="prediction-review-progress" role="status">
        Prediction review: {predictionProgress.reviewed} / {predictionProgress.total} reviewed · {predictionProgress.total - predictionProgress.reviewed} remaining
        <small>For the current result, membership, and source filters.</small>
      </p>}
      <div className="overview-pagination"><span role="status">{filtered.length} of {data.items.length} crops · Page {visiblePage + 1} / {pages}</span>
        <button disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>Previous</button>
        <button disabled={visiblePage === pages - 1} onClick={() => setPage(visiblePage + 1)}>Next</button>
      </div>
      {!filtered.length && <p>No crops match these filters.</p>}
      <div className="mite-grid" style={{ "--crop-size": `${size}px` } as CSSProperties}>
        {filtered.slice(visiblePage * 500, (visiblePage + 1) * 500).map(item => {
          const status = outcomeStatus(item, split);
          const annotation = data.annotation_states[item.id];
          const removed = annotation?.status === "removed";
          const legacy = item.review_key && data.reviews[item.review_key] && annotation?.status === "present";
          const reviewStatus = predictionReviewStatus(item, data.confirmed_predictions, data.prediction_reviews);
          const confirmed = reviewStatus === "mite";
          const rejected = reviewStatus === "not_mite";
          return <button key={item.id} className={`mite-card result-${status}`} onClick={() => { setSelected(item); setConfirmRemoval(false); setNotice(""); setError(""); }}
            aria-label={`${names[status]}, ${item.splits.join(" and ") || "unused"}, ${item.source_id}, x ${item.x.toFixed(1)}, y ${item.y.toFixed(1)}${removed ? ", label removed" : ""}${confirmed ? ", confirmed mite" : rejected ? ", reviewed: not a mite" : reviewStatus === "unreviewed" ? ", unreviewed" : ""}`}>
            <img src={imageUrl(item)} loading="lazy" width="96" height="96" alt="" />
            {removed && <strong className="mite-flag" aria-hidden="true">×</strong>}
            {confirmed && <strong className="mite-confirmed" aria-hidden="true">✓</strong>}
            {rejected && <strong className="prediction-not-mite" aria-hidden="true">−</strong>}
            <span>{names[status]}</span><small>{item.splits.join(" + ") || "Unused"}</small>
            {reviewStatus && <small className="prediction-review-caption">{confirmed ? "Confirmed mite" : rejected ? "Not a mite · reviewed" : "Unreviewed"}</small>}
            {annotation && <small className="prediction-review-caption">{removed ? "Label removed" : annotation.status === "present" ? legacy ? "Legacy flag · label present" : "Current mite label" : "Source changed / unavailable"}</small>}
          </button>;
        })}
      </div>
    </>}
    <dialog className="mite-detail" ref={dialog} onClose={() => { setSelected(null); setConfirmRemoval(false); }} onCancel={e => { if (saving) e.preventDefault(); }} aria-label="Mite crop details">
      {selected && <><button className="detail-close" disabled={saving} onClick={() => setSelected(null)}>Close details</button>
        <h2>{names[outcomeStatus(selected, split)]}</h2>
        <p className="detail-category-help">{resultHelp[outcomeStatus(selected, split)].meaning}</p>
        <p className="detail-category-action">{resultHelp[outcomeStatus(selected, split)].action}</p>
        {selected.kind === "annotation" && <p className="detail-category-help">
          This crop had a mite label marked reviewed in the selected run’s saved annotations. That status can include a mistaken label.
          Open source image shows the current labels, makes their markers visible, and zooms to the matching label if it still exists.
        </p>}
        <img className="detail-crop" src={imageUrl(selected)} width="384" height="384" alt={`Enlarged crop centered at ${selected.x.toFixed(1)}, ${selected.y.toFixed(1)}`} />
        <p>Source: {selected.source_id}<br />Center: {selected.x.toFixed(1)}, {selected.y.toFixed(1)} · {selected.splits.join(" + ") || "Unused in this run"}</p>
        <ul>{selected.outcomes.map((outcome, index) => <li key={`${outcome.tile_id}-${index}`}>
          {outcome.split === "train" ? "Training reconstruction" : "Validation"}: {names[outcome.status]}
          {outcome.confidence != null ? ` (${(outcome.confidence * 100).toFixed(1)}%)` : ""}<small> {outcome.tile_id}</small>
        </li>)}</ul>
        {!selected.outcomes.length && <p>No saved predictions evaluated this crop.</p>}
        <button disabled={saving} onClick={() => { setSelected(null); openSource(selected); }}>Open source image</button>
        {selected.kind === "prediction" && <fieldset disabled={saving}>
          <legend>Review a possible missed mite</legend>
          <p>An unmatched prediction can be a real mite missed during labeling. Confirm it to save a reviewed mite label at the crop center for future training.</p>
          <button disabled={saving || Boolean(selectedConfirmed)} onClick={() => void confirmMite()}>
            {saving ? "Saving mite label…" : selectedConfirmed ? "Mite confirmed ✓" : "Confirm mite — add label"}
          </button>
          {!confirmRemoval && <>{" "}<button aria-pressed={selectedPredictionStatus === "not_mite"} onClick={() => selectedConfirmed ? setConfirmRemoval(true) : void reviewPrediction("not_mite")}>
            {selectedConfirmed ? "Not a mite — remove label" : "Mark reviewed: not a mite"}</button></>}
          {confirmRemoval && <div className="label-removal-confirmation" role="group" aria-label="Confirm label removal">
            <p>This prediction is linked to a current nearby mite label. Confirming will delete that one label from the training data. Other labels and tiles remain available. An already completed image review stays complete.</p>
            <button onClick={() => void reviewPrediction("not_mite")}>Confirm — delete this label</button>{" "}
            <button onClick={() => setConfirmRemoval(false)}>Cancel</button>
          </div>}
          {selectedPredictionStatus === "not_mite" && <>{" "}<button onClick={() => void reviewPrediction(null)}>Clear review mark</button></>}
          <p role="status">{saving ? "Saving prediction review…" : selectedPredictionStatus === "not_mite"
            ? "Reviewed: not a mite. No current reviewed label is linked to this prediction."
            : selectedConfirmed ? "A reviewed mite label exists near this prediction." : "This prediction is awaiting review."}</p>
          <p>A nearby existing label is reused to avoid duplicates from overlapping tiles. Use Not a mite to remove a mistaken linked label here. Open the source image to adjust its center.</p>
        </fieldset>}
        {selected.kind === "annotation" && <fieldset disabled={saving}>
          <legend>Current training label</legend>
          <p role="status">{saving ? "Saving label change…" : selectedAnnotation?.status === "removed"
            ? "× Label removed from the current dataset." : selectedAnnotation?.status === "present"
              ? "This mite label is currently in the dataset." : "Source or annotation changed. Inspect the current source image."}</p>
          {selectedReview && selectedAnnotation?.status === "present" && <p>This crop has a legacy {selectedReview.reason === "not_mite" ? "not-a-mite" : "poor-quality"} flag. The label is still present. Legacy flags no longer exclude tiles.</p>}
          {selectedAnnotation?.status === "present" && !confirmRemoval && <button onClick={() => setConfirmRemoval(true)}>Not a mite — remove label</button>}
          {confirmRemoval && <div className="label-removal-confirmation" role="group" aria-label="Confirm label removal">
            <p>This will delete this annotation from your labeled training data. The image area remains as background; nearby mite labels and tiles stay available. An already completed image review stays complete.</p>
            <button onClick={() => void review("not_mite")}>Confirm — delete this label</button>{" "}
            <button onClick={() => setConfirmRemoval(false)}>Cancel</button>
          </div>}
          {selectedAnnotation?.can_restore && <button onClick={() => void review(null)}>Restore label — it is a mite</button>}
          <p>The red × reflects the current label data. This historical crop and its run result remain visible after removal.</p>
        </fieldset>}
        {notice && <p role="status" className="mite-confirmation-message">{notice}</p>}
        {error && <p role="alert" className="error">{error}</p>}
      </>}
    </dialog>
  </section>;
}
