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

Only one model batch is accepted per image to prevent accidental duplication and preserve experiment provenance. The backend forces imported predictions to unreviewed/model regardless of their submitted flags. IDs must be unique across retained and rejected annotations. Legacy single-image candidate and annotation-export API endpoints remain available; use Dataset exchange for the current portable format.

## Coordinates and files

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

The sidebar provides **Reset current image annotations** (confirmation required) and **Reset ALL annotations...** (type `RESET ALL`). These permanently clear retained annotations, rejected predictions, review status, model-version provenance, and effort statistics for the chosen scope. Original images, corrected images, perspective metadata, and dataset version are preserved. Undo/redo history is cleared. Pending autosaves finish before reset. A cleared image can import a new prediction batch.

API: `POST /api/images/{id}/annotations/reset` or `POST /api/annotations/reset-all` with `{"confirmation":"RESET ALL"}`. As with other editing operations, use one local editor; dataset-wide reset is not a multi-file transaction if the disk fails midway.

The labeling app delegates inference to the sibling `varroa-training` repository; it does not install or load PyTorch itself. `GET /api/models` lists completed training runs whose checkpoint, metadata, configuration and preprocessing sidecar agree with the annotator's normalization settings. In Model Review Mode, choose a model and click **Request predictions**. The backend invokes the training repo's `src.cli infer`, converts its canonical detections to candidate annotations, then persists them through the same provenance/history path as imported candidates. The image must have physical perspective correction, and only one prediction batch is accepted per image. The model selector's **Refresh model list** action picks up newly completed runs.

By default the sibling repository is resolved as `../varroa-training`, and inference uses its `.venv` (`.venv/Scripts/python.exe` on Windows or `.venv/bin/python` elsewhere). Override these with `VARROA_TRAINING_ROOT`, `VARROA_TRAINING_PYTHON`, and optionally `VARROA_PREDICT_TIMEOUT` (seconds; defaults to 600). Restart the API after changing environment variables. Only the API server needs access to the training repository and model files.

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
