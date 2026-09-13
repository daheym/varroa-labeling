import json
import os
import uuid
import threading
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse
from .models import Document, Candidates, Corners, Effort, PredictionRequest, ResetConfirmation
from .detector import (
    DetectorUnavailable,
    PredictionFailed,
    UnknownModel,
    configured_detector,
)
from .perspective import build_transform, transform_points, normalize_image

NORMALIZATION = json.loads(Path(os.environ.get('VARROA_NORMALIZATION_CONFIG',
    Path(__file__).resolve().parents[2] / 'normalization.json')).read_text('utf-8'))

ROOT = Path(os.environ.get('VARROA_DATA_DIR', Path(__file__).resolve().parents[2] / 'data'))
for folder in ('images', 'corrected', 'annotations'):
    (ROOT / folder).mkdir(parents=True, exist_ok=True)
app = FastAPI(title='Varroa annotation API')
lock = threading.RLock()
detector = configured_detector(NORMALIZATION)


def path(image_id):
    try:
        uuid.UUID(image_id)
    except ValueError:
        raise HTTPException(404, 'Unknown image')
    return ROOT / 'annotations' / f'{image_id}.json'


def read(image_id):
    p = path(image_id)
    if not p.exists():
        raise HTTPException(404, 'Unknown image')
    return Document.model_validate_json(p.read_text('utf-8'))


def write(doc):
    p = path(doc.image_id)
    temporary = p.with_suffix('.tmp')
    temporary.write_text(doc.model_dump_json(indent=2), encoding='utf-8')
    temporary.replace(p)


def validate_points(doc):
    points = doc.annotations + doc.rejected_predictions
    if len({p.id for p in points}) != len(points):
        raise HTTPException(422, 'Annotation IDs must be unique')
    width, height = doc.original_width, doc.original_height
    if doc.coordinate_space == 'canonical':
        if not doc.perspective or doc.perspective.get('version') != 1:
            raise HTTPException(422, 'Canonical coordinates require physical normalization')
        width, height = doc.perspective['output_width'], doc.perspective['output_height']
    if any(not (0 <= p.x < width and 0 <= p.y < height) for p in points):
        raise HTTPException(422, 'Coordinates outside analysis image; region excludes annotations. Original document preserved.')


@app.get('/api/normalization')
def normalization_config():
    return NORMALIZATION


@app.get('/api/images')
def images():
    return [json.loads(p.read_text('utf-8')) for p in (ROOT / 'annotations').glob('*.json')]


def reset_document(doc):
    history = ROOT / 'history'
    history.mkdir(exist_ok=True)
    (history / f'{doc.image_id}-{uuid.uuid4()}.json').write_text(doc.model_dump_json(indent=2), encoding='utf-8')
    baseline = ROOT / 'prediction_history' / f'{doc.image_id}.json'
    if baseline.exists():
        baseline.replace(history / f'{doc.image_id}-predictions-{uuid.uuid4()}.json')
    before = ROOT / 'prediction_history' / f'{doc.image_id}.before.json'
    if before.exists():
        before.replace(history / f'{doc.image_id}-before-{uuid.uuid4()}.json')
    doc.review_complete = False
    doc.annotations = []
    doc.rejected_predictions = []
    doc.model_version = None
    doc.effort = Effort()
    write(doc)
    return doc


@app.post('/api/annotations/reset-all')
def reset_all(payload: ResetConfirmation):
    with lock:
        # Validate all documents before starting the destructive writes.
        documents = [Document.model_validate_json(p.read_text('utf-8'))
                     for p in (ROOT / 'annotations').glob('*.json')]
        for doc in documents:
            reset_document(doc)
        return {'reset_images': len(documents)}


@app.post('/api/images/{image_id}/annotations/reset')
def reset_image(image_id: str):
    with lock:
        return reset_document(read(image_id))


@app.post('/api/images')
def upload(file: UploadFile):
    # Stream to disk; retain the exact uploaded bytes, including EXIF metadata.
    image_id = str(uuid.uuid4())
    original = ROOT / 'images' / f'{image_id}.original'
    size = 0
    try:
        with original.open('wb') as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > 200 * 1024 * 1024:
                    raise HTTPException(413, 'Maximum upload is 200 MB')
                out.write(chunk)
        with Image.open(original) as source:
            if source.format not in ('JPEG', 'PNG'):
                raise HTTPException(415, 'Only JPEG and PNG are supported')
            oriented = ImageOps.exif_transpose(source).convert('RGB')
            oriented.save(ROOT / 'images' / f'{image_id}.png')
            width, height = oriented.size
        doc = Document(image_id=image_id, filename=file.filename or 'Image', original_width=width, original_height=height)
        with lock:
            write(doc)
        return doc
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        original.unlink(missing_ok=True)
        raise HTTPException(415, 'Invalid or unsupported image') from exc
    except HTTPException:
        original.unlink(missing_ok=True)
        raise


@app.get('/api/images/{image_id}')
def document(image_id: str):
    return read(image_id)


@app.delete('/api/images/{image_id}')
def delete_image(image_id: str):
    with lock:
        read(image_id)
        artifacts = [
            path(image_id),
            path(image_id).with_suffix('.tmp'),
            ROOT / 'images' / f'{image_id}.original',
            ROOT / 'images' / f'{image_id}.png',
            ROOT / 'prediction_history' / f'{image_id}.json',
            ROOT / 'prediction_history' / f'{image_id}.before.json',
        ]
        for folder, pattern in (
            ('corrected', f'{image_id}-*.png'),
            ('history', f'{image_id}-*.json'),
        ):
            directory = ROOT / folder
            if directory.exists():
                artifacts.extend(directory.glob(pattern))

        for artifact in artifacts:
            if artifact.is_file() or artifact.is_symlink():
                artifact.unlink(missing_ok=True)

        return {'deleted_image_id': image_id}


@app.get('/api/images/{image_id}/file')
def image_file(image_id: str):
    read(image_id)
    return FileResponse(ROOT / 'images' / f'{image_id}.png')


@app.get('/api/images/{image_id}/original')
def original_file(image_id: str):
    doc = read(image_id)
    return FileResponse(ROOT / 'images' / f'{image_id}.original', filename=doc.filename)


@app.put('/api/images/{image_id}/annotations')
def save(image_id: str, doc: Document):
    with lock:
        old = read(image_id)
        if (doc.image_id, doc.original_width, doc.original_height, doc.filename) != (old.image_id, old.original_width, old.original_height, old.filename):
            raise HTTPException(422, 'Image metadata is immutable')
        if doc.coordinate_space != old.coordinate_space or doc.perspective != old.perspective:
            raise HTTPException(409, 'Stale coordinate space or transform; reload image')
        # Original-space documents can be reviewed without physical normalization.
        old_points = {a.id: a for a in old.annotations + old.rejected_predictions}
        for a in doc.annotations + doc.rejected_predictions:
            previous = old_points.get(a.id)
            if previous and previous.source == 'model':
                if (a.source, a.confidence, a.model_version) != (previous.source, previous.confidence, previous.model_version):
                    raise HTTPException(422, 'Model provenance is immutable')
                if (a.x, a.y) != (previous.x, previous.y):
                    a.reviewed = True
                    a.bbox = None  # A point correction invalidates the original detection box.
            if a.source == 'human' and not a.reviewed:
                raise HTTPException(422, 'Human annotations must be reviewed')
        if doc.review_complete and any(not a.reviewed for a in doc.annotations):
            raise HTTPException(422, 'Unreviewed predictions remain')
        doc.perspective = old.perspective
        validate_points(doc)
        write(doc)
        return doc


@app.post('/api/images/{image_id}/candidates')
def candidates(image_id: str, payload: Candidates):
    with lock:
        doc = read(image_id)
        if doc.model_version is not None:
            raise HTTPException(409, 'This image already has a prediction batch')
        if doc.coordinate_space != 'canonical' or payload.perspective_file != doc.perspective['file']:
            raise HTTPException(409, 'Candidates must reference the current canonical perspective_file')
        before = doc.model_dump_json(indent=2)
        for p in payload.annotations:
            if p.confidence is None:
                raise HTTPException(422, "Model predictions require confidence")
            p.source = 'model'
            p.reviewed = False
            p.model_version = payload.model_version
        doc.review_complete = False
        doc.annotations.extend(payload.annotations)
        doc.model_version = payload.model_version
        validate_points(doc)
        from .exchange import annotation_document
        from .interchange import dump, AnnotationFile
        with Image.open(ROOT / 'images' / f'{image_id}.original') as image:
            filename = image_id + ('.jpg' if image.format == 'JPEG' else '.png')
        baseline = annotation_document(doc, filename)
        ids = {p.id for p in payload.annotations}
        baseline['annotations'] = [a for a in baseline['annotations'] if a['id'] in ids]
        try:
            dump(ROOT / 'prediction_history' / f'{image_id}.json', baseline, AnnotationFile)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        (ROOT / 'prediction_history' / f'{image_id}.before.json').write_text(before, encoding='utf-8')
        write(doc)
        return doc


@app.post('/api/images/{image_id}/perspective')
def perspective(image_id: str, payload: Corners):
    with lock:
        doc = read(image_id)
        before = path(image_id).read_text('utf-8')
        profile = NORMALIZATION['board_profiles'].get(payload.board_profile) if payload.board_profile else None
        if payload.board_profile and not profile:
            raise HTTPException(422, 'Unknown board profile')
        width_mm = payload.physical_width_mm if payload.physical_width_mm is not None else (profile or {}).get('physical_width_mm')
        height_mm = payload.physical_height_mm if payload.physical_height_mm is not None else (profile or {}).get('physical_height_mm')
        if width_mm is None or height_mm is None:
            raise HTTPException(422, 'Choose a board profile or provide physical width and height in mm')
        try:
            metadata = build_transform([[p.x, p.y] for p in payload.corners], doc.original_width,
                doc.original_height, width_mm, height_mm, NORMALIZATION['pixels_per_mm'],
                NORMALIZATION['min_source_scale_ratio'], NORMALIZATION['quality_policy'])
            points = doc.annotations + doc.rejected_predictions
            coordinates = [[p.x, p.y] for p in points]
            if doc.coordinate_space == 'canonical':
                coordinates = transform_points(coordinates, doc.perspective['inverse_homography'])
            coordinates = transform_points(coordinates, metadata['homography'])
            for point, (x, y) in zip(points, coordinates):
                point.x, point.y = x, y
            doc.coordinate_space = 'canonical'
            doc.perspective = metadata
            validate_points(doc)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        with Image.open(ROOT / 'images' / f'{image_id}.png') as image:
            corrected = normalize_image(image, metadata)
        name = f'{image_id}-{uuid.uuid4()}.png'
        corrected.save(ROOT / 'corrected' / name)
        doc.perspective.update(file=name, board_profile=payload.board_profile)
        archive = ROOT / 'history'
        archive.mkdir(exist_ok=True)
        (archive / f'{image_id}-{uuid.uuid4()}.json').write_text(before, encoding='utf-8')
        write(doc)
        return doc


@app.get('/api/images/{image_id}/corrected')
def corrected_file(image_id: str):
    doc = read(image_id)
    if not doc.perspective:
        raise HTTPException(404, 'No corrected image')
    return FileResponse(ROOT / 'corrected' / doc.perspective['file'])


@app.get('/api/images/{image_id}/export')
def export(image_id: str):
    doc = read(image_id)
    if doc.coordinate_space != 'canonical':
        raise HTTPException(409, 'Normalize physical region before training export')
    if any(not p.reviewed for p in doc.annotations):
        raise HTTPException(409, 'Review all annotations before ground-truth export')
    return doc


@app.get('/api/models')
def models():
    available = detector.models()
    status = getattr(detector, 'status', 'ready' if available else 'unconfigured')
    if available:
        status = 'ready'
    elif status == 'ready':
        status = 'no_compatible_models'
    return {'models': available, 'status': status}


@app.post('/api/models/train')
def train():
    raise HTTPException(501, 'Training is not implemented. Connect a Detector adapter.')


@app.post('/api/images/{image_id}/predict')
def predict(image_id: str, payload: PredictionRequest):
    with lock:
        doc = read(image_id)
        if doc.coordinate_space != 'canonical' or not doc.perspective:
            raise HTTPException(409, 'Generate physical perspective correction before requesting predictions')
        if doc.model_version is not None:
            raise HTTPException(409, 'This image already has a prediction batch')
        image_path = ROOT / 'images' / f'{image_id}.png'
        perspective = dict(doc.perspective)
        perspective_file = perspective.get('file')

    try:
        result = detector.predict(image_path, perspective=perspective, model_id=payload.model_id)
    except UnknownModel as exc:
        raise HTTPException(404, str(exc)) from exc
    except DetectorUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except PredictionFailed as exc:
        raise HTTPException(422, str(exc)) from exc

    # Prediction runs outside the document lock. Refuse to attach stale results if
    # the user corrected the image or another request imported a batch meanwhile.
    with lock:
        current = read(image_id)
        if current.model_version is not None:
            raise HTTPException(409, 'This image already has a prediction batch')
        if (current.coordinate_space != 'canonical' or not current.perspective
                or current.perspective.get('file') != perspective_file):
            raise HTTPException(409, 'Image perspective changed during prediction; request predictions again')
        return candidates(image_id, result)


# Linked directories are deliberately local filesystem operations, like the existing data store.
from pydantic import BaseModel, Field
from typing import Literal
from .exchange import export_bundle, import_predictions, statistics

class ExchangeRequest(BaseModel):
    directory: str
    dataset_version: str = Field(default="1", min_length=1)
    purpose: Literal["ground_truth", "unreviewed"] = "ground_truth"
    image_ids: list[str] | None = None

@app.post('/api/exchange/export')
def exchange_export(payload: ExchangeRequest):
    with lock:
        try:
            ids = payload.image_ids if payload.image_ids is not None else [p.stem for p in (ROOT/'annotations').glob('*.json')]
            return export_bundle(ROOT, [read(i) for i in ids], payload.directory, payload.dataset_version, payload.purpose)
        except (ValueError, OSError) as exc:
            raise HTTPException(422, str(exc)) from exc

@app.post('/api/exchange/import')
def exchange_import(payload: ExchangeRequest):
    with lock:
        try:
            return import_predictions(ROOT, payload.directory, read, write, validate_points)
        except (ValueError, OSError) as exc:
            raise HTTPException(422, str(exc)) from exc

@app.get('/api/images/{image_id}/review-statistics')
def review_statistics(image_id: str):
    return statistics(ROOT, read(image_id))
