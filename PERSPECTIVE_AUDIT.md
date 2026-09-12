# Perspective audit (before changes, 2026-09-12)

Both repositories were inspected and this behavior was reported before any implementation edits.

| Question | Original behavior |
|---|---|
| Are four points only metadata? | Four clicks/dragging update React state only. They are not saved until Generate corrected image. That action stores metadata **and** writes a corrected raster. |
| Is a homography computed? | Yes, only by POST `/api/images/{id}/perspective`, via OpenCV getPerspectiveTransform. |
| Is a rectified image generated? | Yes, a separate PNG under data/corrected. Width/height use maximum opposite edge lengths. Destination corners use W-1/H-1. |
| Which coordinates do annotations use? | Original EXIF-oriented pixels. Canvas always requests `/file`; schemas, bounds checks, candidate import and export all use original dimensions. |
| Does training use perspective? | No. LabelingDocument accepts the dictionary but load_annotation drops it. |
| What gets tiled? | The complete EXIF-oriented original in both preparation and inference. Evaluation and overlays assume the same original space. |

## Evidence locations at audit time

Annotation: `frontend/src/App.tsx` (corner state, generate action, separate corrected link), `frontend/src/Canvas.tsx` (original `/file` and dimensions), `backend/app/main.py` (perspective endpoint, annotation validation), `backend/app/models.py` (original-only coordinate space), `backend/app/detector.py` (original-coordinate adapter assumption).

Training: `src/dataset/validation.py` (drops perspective), `src/dataset/prepare.py` (original image crop), `src/inference/predict.py` (original tiling and overlay), `src/evaluation/evaluate.py` and `visualize.py` (original-coordinate metrics/visualizations).

## Inconsistencies and adopted migration

Correction existed as a separate image artifact, never as the annotation/training space. There were no physical dimensions, common pixels/mm, low-resolution checks or model normalization contract. Reloading an image also cleared corner handles instead of restoring stored corners.

The implemented design uses per-image physical board dimensions, named profiles/custom values and a common pixels/mm. Original and Corrected views are explicit; only Corrected permits annotation. A document-wide coordinate-space guarantee prevents mixing. Recorrection converts old points through original space, rejects excluded points and archives exact previous JSON. Training normalizes before fixed-pixel tiling; inference, evaluation and overlays share that operation. Legacy unnormalized processing requires explicit compatibility configuration; legacy perspective without physical dimensions must be migrated. Existing real datasets were not rewritten during this task.

## Implementation files

Annotation: `backend/app/{main,models,detector,perspective}.py`, `backend/tests/{test_api,test_perspective}.py`, `frontend/src/{App,Canvas}.tsx`, `frontend/src/types.ts`, `normalization.json`, `README.md`, `PERSPECTIVE.md`.

Training: `src/config.py`, `src/cli.py`, `src/dataset/{validation,prepare,perspective}.py`, `src/inference/{predict,export,contract}.py`, `src/evaluation/{evaluate,visualize,loo}.py`, `src/training/{train,overfit}.py`, `configs/normalization.json`, `tests/{test_dataset,test_inference,test_overfit,test_training,test_perspective}.py`, `README.md`, `PERSPECTIVE.md`.

The deterministic equations, boundary convention, quality estimate, migration steps and future PWA requirements are documented in [PERSPECTIVE.md](PERSPECTIVE.md).
