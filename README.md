# Varroa annotation tool

Local React + TypeScript + Vite / FastAPI annotation workspace. Inference can be delegated to the sibling `varroa-training` repository; training is performed there. Requires Python 3.11+ and Node.js 20.19+ (Node 22+ recommended).

## Setup

From the repository root, in PowerShell:

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r backend/requirements.txt
.venv/Scripts/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open http://127.0.0.1:5173. Vite proxies `/api` to FastAPI. On macOS/Linux use `.venv/bin/python` instead. No conda is needed. Run one backend worker; storage is designed for one local annotator, not concurrent editors. Do not expose these unauthenticated local services publicly.

For the exact tested Python dependencies use `backend/requirements-lock.txt`; the frontend includes `package-lock.json` for `npm ci`.

## Workflow

1. **Choose an image.** Upload a JPEG/PNG or select a previously uploaded image.
2. **Prepare the image.** To normalize the board, use **Original** view, select a profile or enter its physical width and height in mm, then place corners in top-left, top-right, bottom-right, bottom-left order. Drag corners to refine them. Generate the corrected image to map existing points to the configured pixels/mm scale. Physical correction is required for model predictions; manual labels can remain in original pixels. Review any source-resolution warning.
3. **Annotate and review.** In Manual mode, click the image to add a reviewed human annotation. In Model review mode, request predictions from a compatible trained model or import a prediction directory through Dataset exchange. Blue dashed markers are unreviewed predictions; green markers are human or reviewed predictions. Accept a prediction, drag it to correct its position, delete it to reject it, or click the image to add a missed mite.
4. **Finish image review.** Check the whole image before marking it complete. Empty images can also be marked complete and are valid negatives for training.
5. **Exchange the dataset.** Enter a folder path on the API server. Exports use a new folder outside app data and the specified dataset version; imports read an existing predictions folder and ignore the export version. Export reviewed images for training, export eligible images for external model prediction, or import model predictions for review.
6. **Train the model.** After every dataset image has physical correction and is marked complete, click **Start training**. The sibling training repository validates the live dataset, prepares fresh tiles, and runs production training in the background. The sidebar reports completion or failure and exposes the training log.

Mouse wheel zooms around the pointer. Hold Space while dragging to pan. Fit image resets the view. Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z redoes. History retains 100 edits within the current image session. JSON autosaves 600 ms after the last annotation change. Requests are serialized. Save now retries failed saves. Image switching, prediction requests, correction, and dataset exchange wait for saves; failed saves block these operations. Closing with unsaved work prompts the browser's standard warning. Ground-truth export requires every included image to be marked complete and every retained annotation to be reviewed.

Press **H** or click **Hide annotations / Show annotations** above the canvas to compare predictions with the unobstructed image. This temporarily hides all annotation markers without changing saved labels, prediction review state, or the current zoom and pan. Adding and moving annotations is disabled while markers are hidden; zooming and panning remain available. The shortcut is ignored while typing in form fields.

Press **T** or click **Show tile borders / Hide tile borders** to inspect the full
tile grid and its overlaps. Solid cyan outlines show training tiles, dashed purple
outlines show validation tiles, and faint dotted gray outlines show tiles omitted
from the run. Omitted windows are reconstructed from the run's saved tile size,
overlap, and source dimensions, including the edge-anchored final row and column;
retained tile geometry and membership come directly from its saved manifest.
The overlay starts off and works independently of annotation visibility, zoom,
and pan. The legend includes counts for each usage. Images opened directly use the
latest completed run with matching image geometry. The toolbar names that run.
Older runs without grid settings show only saved tiles and an explanation that
the complete grid is unavailable. The T shortcut ignores form fields, editable
text, modifier combinations, and held-key repeats.

Only one model batch is accepted per image to prevent accidental duplication and preserve experiment provenance. The backend forces imported predictions to unreviewed/model regardless of their submitted flags. IDs must be unique across retained and rejected annotations. Legacy single-image candidate and annotation-export API endpoints remain available; use Dataset exchange for the current portable format.

## Coordinates and files

### Mite overview

The header's **Mite overview** tab displays completed runs from the configured
sibling training repository. It shows a dense grid of individual 96px mite context
crops, with adjustable display size and filters for run, source image, training or
validation membership, discrepancies and current label status. Click a crop to enlarge
it, inspect confidence and individual tile outcomes, or open its source image.
Switching between **Annotate** and **Mite overview** preserves the selected run,
filters, crop size, and overview page for the current app session. Returning to the
overview reloads current label and review information with those settings.
Each annotation appears once; overlapping tiles may give mixed results and may
put an object in both train and validation. Unmatched predictions are shown too
and can repeat across overlapping tiles. Colors describe agreement with saved
annotations, not a final judgment about the object.

**Show tile borders** at the top of **Mite overview** also overlays the crop grid
and enlarged crop details. A dashed gold halo highlights tiles contributing
outcomes to each crop while preserving their training/validation color. The
details report training, validation, and omitted tile counts at the crop center.
Both the overview header and crop dialog have a toggle, and **T** works in both.
Visibility stays synchronized across the overview, dialog, and source image.
**Open source image** carries
the selected run, contributing tiles, and overlay visibility to the full image so
you can compare complete tile windows. Borders outside a small crop are visible
there. The overlay always includes all splits and omitted windows, regardless of the Membership
filter, to make overlaps visible. It uses saved run geometry rather than current
tiling settings, needs no retraining or overview rebuild, and is withheld if the
source view or perspective no longer matches. Restart the backend and reload the
frontend after updating to enable the tile endpoints.

For an orange **Unmatched prediction** that is actually a mite, click the crop and
choose **Confirm mite — add label**. This saves a reviewed mite annotation at the
prediction center, with its confidence and training-run provenance, for the next
training dataset. A nearby existing annotation within the run's matching tolerance
is reused to avoid duplicates from overlapping tiles or repeated clicks; a nearby
unreviewed prediction is accepted in place. Confirmed predictions show a green
check and can be found with **Review status → Confirmed mites from predictions**.
Saved run predictions and metrics retain their original results.

For an unmatched prediction that is **not** a mite, choose **Mark reviewed: not a
mite**. If it has no current label, a gray minus badge records that you checked it.
If it is linked to a current reviewed label, **Not a mite — remove label** offers a
confirmation and deletes that one linked annotation directly. A current label takes
priority over an old review mark. Nearby labels and tiles are preserved.

Use **Review status → Unreviewed predictions** to work through remaining
detections, **Reviewed predictions** to see completed decisions, or **Reviewed:
not a mite** to revisit rejections. The progress counter follows the current result,
membership, and source filters. Decisions persist per crop and run in
`data/inspection_reviews/`; repeated views from overlapping tiles can be reviewed
separately. **Clear review mark** undoes a rejection. Confirming a mite later clears
its rejection mark. Back up `inspection_reviews` with app data.

The collapsible **Category guide** explains each result color, train/validation
membership, review badges, and what each review action changes. Filter explanations
update with your selection, and crop details include the result meaning and suggested
next step.

**Open source image** makes annotation markers visible and zooms to the saved crop
center, including unmatched predictions without a current label. An existing label
is selected; otherwise a temporary orange ring and crosshair identify the location,
with coordinates shown above the canvas. **Center overview location** returns to it
after panning or fitting the image. **Clear location guide** dismisses the guide;
it is not saved as an annotation. Run results refer to the saved
annotation snapshot; a label marked reviewed can still be mistaken.

For an existing annotation, choose **Not a mite — remove label**, then confirm the
on-screen explanation. This removes only that annotation from the live labeled
data. Its image area remains available as background, with neighboring mites and
tiles intact. An already completed image review stays complete, so no visit to the
source editor or second completion step is needed. Incomplete reviews stay incomplete.
The historical crop stays visible with a red **× Removed label** badge, derived from
the current annotation document, including deletions made in the source editor.
Use **Review status → Removed labels** to find these crops, or **Current mite labels**
to see labels still present. **Restore label — it is a mite** reverses an overview
removal and preserves original annotation provenance. Recovery records live in
`data/annotation_reviews/`, and pre-edit documents are archived in `data/history/`.
Back up both directories with the app data. Restoration is available only for
removals recorded by this feature.

Adding or accepting a previously missing mite still reopens source image review.
Use **Open source image** to adjust a center and finish that review before training.
Changed source content, perspective, or annotation coordinates block edits from
an old run rather than deleting a different nearby annotation.

New training runs generate the overview automatically. For an older run, choose
**Build saved overview**; this uses saved predictions without retraining. Training
crops without saved predictions are explicitly marked **Not evaluated**. Future
runs also save training reconstruction diagnostics separately from validation scores.
Use **Refresh runs** after externally completed training. Restart the backend and
reload the frontend after installing this feature.

Legacy **not a mite** and **poor quality** flags under `data/quality_reviews/` no
longer exclude tiles during preparation in the updated sibling training repository.
They remain visible under **Legacy flags — review labels** while a label is present,
so you can explicitly review and delete mistaken labels. Old flags are never silently
converted into deletions and do not produce the red removed-label badge. Existing
prepared datasets, runs and metrics remain unchanged; the next preparation uses the
current labels. The annotation changes are included in normal dataset exports.

API: `GET /api/inspection/runs`, `GET /api/inspection/runs/{id}`,
`POST /api/inspection/runs/{id}/build`, `PUT /api/inspection/review`, and
`POST /api/inspection/confirm-mite`, and `PUT /api/inspection/prediction-review`.

```text
backend/app/          API, validated schemas, detector interface
backend/tests/        API, persistence, review, EXIF and homography tests
frontend/src/         canvas, workspace, coordinate functions and tests
data/images/          byte-identical .original uploads + full-resolution oriented PNGs
data/corrected/       separate perspective-corrected PNGs
data/annotations/     one atomically replaced JSON document per image
```

Uploads are never resized. EXIF orientation is applied to a full-resolution display PNG; original width/height and source corners refer to that oriented raster; canonical annotation dimensions are stored in perspective metadata. The exact source bytes are retained separately and downloadable at `/api/images/{id}/original`. This explicitly avoids browser/OpenCV EXIF interpretation differences. Supported uploads are capped at 200 MB; Pillow's decompression-bomb protection also applies. Large decoded images require substantial browser/backend RAM; no thumbnails replace the annotation raster.

Stage pointer positions are CSS pixels. The inverse transform is `(screen - translation) / scale`; device pixel ratio does not enter annotation coordinates. Markers keep constant screen size. Annotation moves commit only on drag end. Canvas resizing refits the viewport without modifying stored coordinates. Coordinates are fractional, bounded by `[0,canonical_width)` and `[0,canonical_height)`.

JSON includes `image_id`, dimensions, `coordinate_space`, `perspective`, `dataset_version`, `model_version`, annotations, rejected prediction records, and effort statistics. Annotation class is named `className` consistently with the active-learning schema. Perspective metadata records source points, physical dimensions, pixels/mm, quality, homography and inverse, output size and generated filename. Export uses canonical coordinates. See [the normalization and migration contract](PERSPECTIVE.md) for deterministic geometry, per-image profiles, source quality, legacy conversion and the PWA contract.

Effort counters record adds, acceptance actions, deletes, moves, undo and redo without erasing effort on undo. Current prediction/accepted/rejected/manual counts derive from document state. Active seconds estimates interaction time from gaps between edits capped at 60 seconds per action; it is not precise labor timing. Choose the dataset version in Dataset exchange; it is written to the exported manifest. Review provenance and counters support future comparisons, but baseline experimental timing must be collected separately.

## Model integration

### Reset annotations

To remove test predictions without losing training labels, open **Annotate and review → Model review mode → Discard unreviewed predictions**. This removes only unreviewed model markers from the current image, preserving human labels, accepted/corrected predictions, rejected predictions, geometry, and effort statistics. It does not record rejection decisions. Pending saves finish first and undo history is cleared. When no model records remain, the batch is released for another prediction request and its baseline is archived under `data/history`. If the document otherwise matches its pre-prediction snapshot, its previous completion status is restored. Restart the API after updating for the new `POST /api/images/{id}/predictions/discard-unreviewed` endpoint.

The sidebar provides **Reset current image annotations** (confirmation required) and **Reset ALL annotations...** (type `RESET ALL`). These permanently clear retained annotations, rejected predictions, review status, model-version provenance, and effort statistics for the chosen scope. Original images, corrected images, perspective metadata, and dataset version are preserved. Undo/redo history is cleared. Pending autosaves finish before reset. A cleared image can import a new prediction batch.

API: `POST /api/images/{id}/annotations/reset` or `POST /api/annotations/reset-all` with `{"confirmation":"RESET ALL"}`. As with other editing operations, use one local editor; dataset-wide reset is not a multi-file transaction if the disk fails midway.

The labeling app delegates inference to the sibling `varroa-training` repository; it does not install or load PyTorch itself. `GET /api/models` lists completed training runs whose checkpoint, metadata, configuration and preprocessing sidecar agree with the annotator's normalization settings. In Model Review Mode, choose a model and click **Request predictions**. The backend invokes the training repo's `src.cli infer`, converts its canonical detections to candidate annotations, then persists them through the same provenance/history path as imported candidates. The image must have physical perspective correction, and only one prediction batch is accepted per image. The model selector's **Refresh model list** action picks up newly completed runs.

By default the sibling repository is resolved as `../varroa-training`, and inference uses its `.venv` (`.venv/Scripts/python.exe` on Windows or `.venv/bin/python` elsewhere). Override these with `VARROA_TRAINING_ROOT`, `VARROA_TRAINING_PYTHON`, and optionally `VARROA_PREDICT_TIMEOUT` (seconds; defaults to 600). Restart the API after changing environment variables. Only the API server needs access to the training repository and model files.

Prediction requests start a background job with `POST /api/images/{id}/prediction` (`model_id` and a UUID `request_id`), then poll `GET /api/images/{id}/prediction`. The canvas shows an activity bar, elapsed time, and completion or error details. The bar indicates activity; it does not estimate a completion percentage. Transient start failures (including an unstructured HTTP 400) are retried once with the same request ID, so a lost response cannot launch duplicate inference. Selecting an image with an active job resumes status checks. Jobs are held in memory and require one backend worker; restarting the API loses active job status. The original synchronous `/predict` API remains available. Restart the API after updating to enable the new job endpoints.

**Start training** invokes `scripts/train-production.ps1` in the sibling repository, using its standard 50-epoch maximum and 10-epoch early-stopping patience. PowerShell (`powershell.exe` or `pwsh`) and the training repository's configured `.venv` are required. The action uses every image in the live labeling dataset and therefore refuses to start until every image is physically normalized, fully reviewed, and marked complete. Only one training process can be started through the labeling API at a time. `POST /api/models/train` starts the background job and `GET /api/models/train` returns its current status and recent log output.

API documentation: http://127.0.0.1:8000/docs. Override storage with the `VARROA_DATA_DIR` environment variable. Back up the data directory to preserve images and work. Perspective operations and imports clear frontend undo history; they are separate persisted operations.

## Checks

```powershell
.venv/Scripts/python -m pytest backend/tests -q
cd frontend
npm test
npm run build
```

The production build goes to `frontend/dist`. Vite's development proxy is not embedded in the build: production hosting must route `/api` to FastAPI. The documented local workflow uses the Vite dev server.

Normalization configuration: `normalization.json`, optionally overridden with `VARROA_NORMALIZATION_CONFIG`. The server owns the common scale; each image supplies its physical dimensions. Successful recorrections archive prior JSON in `data/history/`. Restart the backend after changing configuration.

## Active-learning interchange

Export reviewed datasets and exchange model predictions through portable or linked directories.
See [the end-to-end workflow](docs/active-learning.md), [v1 JSON Schema](schemas/varroa-annotation-v1.schema.json), and [example files](examples/interchange).
