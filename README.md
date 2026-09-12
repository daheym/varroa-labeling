# Varroa annotation tool

Local React + TypeScript + Vite / FastAPI annotation workspace. No inference or training is implemented. Requires Python 3.11+ and Node.js 20.19+ (Node 22+ recommended).

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

1. Upload a JPEG/PNG or select a previously uploaded image.
2. In Manual Mode, click to add a reviewed human annotation. Click markers to select; drag to correct coordinates; Delete/Backspace removes the selection.
3. Wheel zooms around the pointer. Hold Space while dragging to pan. Fit image resets the view. Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z redoes. History retains 100 edits within the current image session.
4. Model Review Mode accepts candidate JSON using the format below. Amber dashed markers are unreviewed model candidates; green markers are human or reviewed. Accept selected, drag to correct (also marks reviewed), delete to reject, and click the image to add missed mites. Model provenance is preserved when correcting a prediction. Mark all reviewed explicitly confirms every remaining candidate.
5. Perspective correction: enable Place corners and click top-left, top-right, bottom-right, bottom-left. Drag corners, then Generate corrected image. Open the resulting image in a separate tab. Annotation editing remains on the original image.
6. JSON autosaves 600 ms after the last annotation change. Requests are serialized. Save now retries failed saves. Image switching, candidate import, correction, and export wait for saves; failed saves block these operations. Closing with unsaved work prompts the browser's standard warning. Export is blocked until every retained annotation is reviewed.

Candidate import example (coordinates in original, EXIF-oriented pixels):

```json
{
  "model_version": "experiment-001",
  "annotations": [
    {"id":"candidate-1","className":"varroa","x":1234.5,"y":987.2,"source":"model","confidence":0.87,"reviewed":false}
  ]
}
```

Only one model batch is accepted per image to prevent accidental duplication and preserve experiment provenance. The backend forces imported candidates to unreviewed/model regardless of their submitted flags. IDs must be unique across retained and rejected annotations.

## Coordinates and files

```text
backend/app/          API, validated schemas, detector interface
backend/tests/        API, persistence, review, EXIF and homography tests
frontend/src/         canvas, workspace, coordinate functions and tests
data/images/          byte-identical .original uploads + full-resolution oriented PNGs
data/corrected/       separate perspective-corrected PNGs
data/annotations/     one atomically replaced JSON document per image
```

Uploads are never resized. EXIF orientation is applied to a full-resolution display PNG; width, height and annotation coordinates refer to that oriented raster. The exact source bytes are retained separately and downloadable at `/api/images/{id}/original`. This explicitly avoids browser/OpenCV EXIF interpretation differences. Supported uploads are capped at 200 MB; Pillow's decompression-bomb protection also applies. Large decoded images require substantial browser/backend RAM; no thumbnails replace the annotation raster.

Stage pointer positions are CSS pixels. The inverse transform is `(screen - translation) / scale`; device pixel ratio does not enter annotation coordinates. Markers keep constant screen size. Annotation moves commit only on drag end. Canvas resizing refits the viewport without modifying stored coordinates. Coordinates are fractional, bounded by `[0,width)` and `[0,height)`.

JSON includes `image_id`, dimensions, `coordinate_space`, `perspective`, `dataset_version`, `model_version`, annotations, rejected prediction records, and effort statistics. Annotation class is named `className` consistently with the active-learning schema. Perspective metadata records source corners, homography and inverse, output size and generated filename. Apply the homography to original coordinates and divide by the homogeneous third component to map annotations into corrected pixels; export itself remains in original coordinates.

Effort counters record adds, acceptance actions, deletes, moves, undo and redo without erasing effort on undo. Current prediction/accepted/rejected/manual counts derive from document state. Active seconds estimates interaction time from gaps between edits capped at 60 seconds per action; it is not precise labor timing. Dataset version is user-controlled metadata. Review provenance and counters support future comparisons, but baseline experimental timing must be collected separately.

## Model integration

### Reset annotations

The sidebar provides **Reset current image annotations** (confirmation required) and **Reset ALL annotations…** (type `RESET ALL`). These permanently clear retained annotations, rejected predictions, model-version provenance, and effort statistics for the chosen scope. Original images, corrected images, perspective metadata, and dataset version are preserved. Undo/redo history is cleared. Pending autosaves finish before reset. A cleared image can import a new prediction batch.

API: `POST /api/images/{id}/annotations/reset` or `POST /api/annotations/reset-all` with `{"confirmation":"RESET ALL"}`. As with other editing operations, use one local editor; dataset-wide reset is not a multi-file transaction if the disk fails midway.

`backend/app/detector.py` defines a `Detector` protocol for a future PyTorch/Ultralytics adapter. `GET /api/models` currently returns an empty registry. `POST /api/models/train` and `POST /api/images/{id}/predict` return HTTP 501. Connect a detector, validate its outputs through `Candidates`, and reuse the candidate-import validation/storage path. Training should consume only reviewed exports and record dataset and model versions. No fake predictions are generated.

API documentation: http://127.0.0.1:8000/docs. Override storage with the `VARROA_DATA_DIR` environment variable. Back up the data directory to preserve images and work. Perspective operations and imports clear frontend undo history; they are separate persisted operations.

## Checks

```powershell
.venv/Scripts/python -m pytest backend/tests -q
cd frontend
npm test
npm run build
```

The production build goes to `frontend/dist`. Vite's development proxy is not embedded in the build: production hosting must route `/api` to FastAPI. The documented local workflow uses the Vite dev server.
