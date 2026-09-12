import json
import os
import uuid
import threading
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse
from .models import Document, Candidates, Corners, Effort, ResetConfirmation
from .detector import UnconfiguredDetector

ROOT = Path(os.environ.get('VARROA_DATA_DIR', Path(__file__).resolve().parents[2] / 'data'))
for folder in ('images', 'corrected', 'annotations'):
    (ROOT / folder).mkdir(parents=True, exist_ok=True)
app = FastAPI(title='Varroa annotation API')
lock = threading.RLock()
detector = UnconfiguredDetector()


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
    if any(not (0 <= p.x < doc.original_width and 0 <= p.y < doc.original_height) for p in points):
        raise HTTPException(422, 'Coordinates outside original image')


@app.get('/api/images')
def images():
    return [json.loads(p.read_text('utf-8')) for p in (ROOT / 'annotations').glob('*.json')]


def reset_document(doc):
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
        validate_points(doc)
        doc.perspective = old.perspective
        write(doc)
        return doc


@app.post('/api/images/{image_id}/candidates')
def candidates(image_id: str, payload: Candidates):
    with lock:
        doc = read(image_id)
        if doc.model_version is not None:
            raise HTTPException(409, 'This image already has a prediction batch')
        for p in payload.annotations:
            p.source = 'model'
            p.reviewed = False
        doc.annotations.extend(payload.annotations)
        doc.model_version = payload.model_version
        validate_points(doc)
        write(doc)
        return doc


@app.post('/api/images/{image_id}/perspective')
def perspective(image_id: str, payload: Corners):
    with lock:
        doc = read(image_id)
        src = np.float32([[p.x, p.y] for p in payload.corners])
        if any(not (0 <= p.x < doc.original_width and 0 <= p.y < doc.original_height) for p in payload.corners):
            raise HTTPException(422, 'Corners outside image')
        if not cv2.isContourConvex(src) or abs(cv2.contourArea(src)) < 4:
            raise HTTPException(422, 'Corners must form a non-degenerate convex quadrilateral in perimeter order')
        w = max(2, round(max(np.linalg.norm(src[1]-src[0]), np.linalg.norm(src[2]-src[3]))))
        h = max(2, round(max(np.linalg.norm(src[3]-src[0]), np.linalg.norm(src[2]-src[1]))))
        if w * h > 80_000_000:
            raise HTTPException(422, 'Corrected image exceeds 80 megapixels')
        matrix = cv2.getPerspectiveTransform(src, np.float32([[0, 0], [w-1, 0], [w-1, h-1], [0, h-1]]))
        image = cv2.imread(str(ROOT / 'images' / f'{image_id}.png'))
        corrected = cv2.warpPerspective(image, matrix, (w, h))
        name = f'{image_id}-{uuid.uuid4()}.png'
        if not cv2.imwrite(str(ROOT / 'corrected' / name), corrected):
            raise HTTPException(500, 'Could not write corrected image')
        doc.perspective = {'source_corners': src.tolist(), 'homography': matrix.tolist(), 'inverse_homography': np.linalg.inv(matrix).tolist(), 'width': w, 'height': h, 'file': name}
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
    if any(not p.reviewed for p in doc.annotations):
        raise HTTPException(409, 'Review all annotations before ground-truth export')
    return doc


@app.get('/api/models')
def models():
    return {'models': [], 'status': 'unconfigured'}


@app.post('/api/models/train')
def train():
    raise HTTPException(501, 'Training is not implemented. Connect a Detector adapter.')


@app.post('/api/images/{image_id}/predict')
def predict(image_id: str):
    read(image_id)
    raise HTTPException(501, 'Inference is not implemented. Import candidate JSON or connect a Detector adapter.')
