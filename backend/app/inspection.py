"""Read run artifacts and apply overview decisions to the current annotations."""
import hashlib
import json
import math
import subprocess
import uuid
from bisect import bisect_left, bisect_right
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, ImageOps
from .models import Annotation


def document_geometry_hash(doc):
    width, height = doc.original_width, doc.original_height
    perspective = doc.perspective or {}
    if doc.coordinate_space == 'canonical':
        width, height = perspective['output_width'], perspective['output_height']
    geometry = [doc.coordinate_space, width, height, perspective.get('homography')]
    return hashlib.sha256(json.dumps(geometry, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def snapshot_geometry_hash(record):
    geometry = [record['coordinate_space'], record['width'], record['height'],
                (record.get('perspective') or {}).get('homography')]
    return hashlib.sha256(json.dumps(geometry, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_snapshot(data_root, doc, geometry_sha256, source_sha256):
    if document_geometry_hash(doc) != geometry_sha256:
        raise HTTPException(409, 'Perspective changed since this run; review the current image instead')
    with Image.open(data_root / 'images' / f'{doc.image_id}.png') as source:
        image = ImageOps.exif_transpose(source).convert('RGB')
    digest = hashlib.sha256(str(image.size).encode() + image.tobytes()).hexdigest()
    if digest != source_sha256:
        raise HTTPException(409, 'Source image changed since this run')


def nearby_annotation(doc, item, radius):
    nearby = [a for a in doc.annotations if math.hypot(a.x - item['x'], a.y - item['y']) <= radius]
    return min(nearby, key=lambda a: math.hypot(a.x - item['x'], a.y - item['y']), default=None)


def confirmation_radius(manifest):
    # Use the run's point matching tolerance to guard against duplicate labels
    # from overlapping tile predictions or repeated confirmation requests.
    return float(manifest['config']['match_radius'])


def confirmed_predictions(training_root, run_id, items, read_document):
    manifest = json.loads((run_path(training_root, run_id) / 'dataset_manifest.json').read_text('utf-8'))
    sources = {r['id']: r for r in manifest.get('sources', [])}
    documents, confirmed = {}, {}
    for item in items:
        if item['kind'] != 'prediction' or item['source_id'] not in sources:
            continue
        if item['source_id'] not in documents:
            try:
                documents[item['source_id']] = read_document(item['source_id'])
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                documents[item['source_id']] = None
        doc = documents[item['source_id']]
        if doc is None or document_geometry_hash(doc) != snapshot_geometry_hash(sources[item['source_id']]):
            continue
        annotation = nearby_annotation(doc, item, confirmation_radius(manifest))
        if annotation and annotation.reviewed:
            confirmed[item['id']] = annotation.id
    return confirmed


def read_prediction_reviews(data_root, training_root, run_id):
    run_path(training_root, run_id)  # Only registered run IDs can become filenames.
    path = data_root / 'inspection_reviews' / f'{run_id}.json'
    if not path.is_file():
        return {}
    saved = json.loads(path.read_text('utf-8'))
    return saved['predictions']


def save_prediction_review(data_root, training_root, run_id, item_id, decision):
    item = next((i for i in payload(training_root, run_id)['items'] if i['id'] == item_id), None)
    if not item or item['kind'] != 'prediction':
        raise HTTPException(422, 'Prediction review requires an unmatched prediction crop')
    reviews = read_prediction_reviews(data_root, training_root, run_id)
    if decision is None:
        reviews.pop(item_id, None)
    else:
        reviews[item_id] = dict(decision=decision, source_id=item['source_id'],
                                updated_at=datetime.now(timezone.utc).isoformat())
    directory = data_root / 'inspection_reviews'
    directory.mkdir(exist_ok=True)
    path = directory / f'{run_id}.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(dict(schema_version=1, run_id=run_id, predictions=reviews),
                                    indent=2, allow_nan=False) + '\n', encoding='utf-8')
    temporary.replace(path)
    return reviews


def review_prediction(data_root, training_root, run_id, item_id, decision, expected_annotation_id,
                      read_document, write_document):
    item = next((i for i in payload(training_root, run_id)['items'] if i['id'] == item_id), None)
    if not item or item['kind'] != 'prediction':
        raise HTTPException(422, 'Prediction review requires an unmatched prediction crop')
    result = dict(document=None, annotation_id=None)
    if decision == 'not_mite':
        manifest = json.loads((run_path(training_root, run_id) / 'dataset_manifest.json').read_text('utf-8'))
        source = next((r for r in manifest['sources'] if r['id'] == item['source_id']), None)
        if not source:
            raise HTTPException(422, 'Prediction has no source snapshot')
        doc = read_document(item['source_id'])
        validate_snapshot(data_root, doc, snapshot_geometry_hash(source), source['sha256'])
        annotation = nearby_annotation(doc, item, confirmation_radius(manifest))
        if annotation:
            if annotation.id != expected_annotation_id:
                raise HTTPException(409, 'A current label exists near this prediction. Refresh and confirm its removal.')
            before = doc.model_dump_json(indent=2)
            doc.annotations = [a for a in doc.annotations if a.id != annotation.id]
            if annotation.source == 'model':
                doc.rejected_predictions.append(annotation.model_copy(update={'reviewed': True}))
            doc.effort.deletes += 1
            history = data_root / 'history'
            history.mkdir(exist_ok=True)
            (history / f'{doc.image_id}-before-overview-review-{uuid.uuid4()}.json').write_text(before, encoding='utf-8')
            write_document(doc)
            result['document'] = doc
    result['prediction_reviews'] = save_prediction_review(data_root, training_root, run_id, item_id, decision)
    return result


def confirm_mite(data_root, training_root, run_id, item_id, read_document, write_document, validate_points):
    item = next((i for i in payload(training_root, run_id)['items'] if i['id'] == item_id), None)
    if not item or item['kind'] != 'prediction':
        raise HTTPException(422, 'Confirm mite requires an unmatched prediction crop')
    run = run_path(training_root, run_id)
    manifest = json.loads((run / 'dataset_manifest.json').read_text('utf-8'))
    source = next((r for r in manifest['sources'] if r['id'] == item['source_id']), None)
    if not source:
        raise HTTPException(422, 'Prediction has no source snapshot')
    doc = read_document(item['source_id'])
    validate_snapshot(data_root, doc, snapshot_geometry_hash(source), source['sha256'])
    radius = confirmation_radius(manifest)
    x, y = item['x'], item['y']
    width, height = ((doc.perspective['output_width'], doc.perspective['output_height'])
                     if doc.coordinate_space == 'canonical' else (doc.original_width, doc.original_height))
    if not (math.isfinite(x) and math.isfinite(y) and 0 <= x < width and 0 <= y < height):
        raise HTTPException(422, 'Prediction center is outside the source image; use the source editor')
    existing = nearby_annotation(doc, item, radius)
    if existing and existing.reviewed:
        return dict(document=doc, annotation_id=existing.id, added=False,
                    message=f'A reviewed mite is already labeled within {radius:g}px. No duplicate was added.')
    before = doc.model_dump_json(indent=2)
    if existing:
        existing.reviewed = True
        annotation = existing
        message = 'Confirmed the nearby existing prediction as a reviewed mite.'
    else:
        metadata = json.loads((run / 'metadata.json').read_text('utf-8'))
        version = f"inspection:{run.relative_to(Path(training_root).resolve() / 'runs').as_posix()}"
        if metadata.get('checkpoint_sha256'):
            version += '@' + metadata['checkpoint_sha256'][:12]
        confidence = item['outcomes'][0]['confidence']
        annotation = Annotation(id=str(uuid.uuid4()), x=x, y=y, source='model', reviewed=True,
                                confidence=confidence, model_version=version)
        doc.annotations.append(annotation)
        message = 'Added a reviewed mite label. Finish source image review before the next training run.'
    doc.review_complete = False
    doc.effort.accepts += 1
    validate_points(doc)
    history = data_root / 'history'
    history.mkdir(exist_ok=True)
    (history / f'{doc.image_id}-before-confirm-mite-{uuid.uuid4()}.json').write_text(before, encoding='utf-8')
    write_document(doc)
    return dict(document=doc, annotation_id=annotation.id, added=existing is None, message=message)


def runs(training_root):
    root = Path(training_root).resolve() / 'runs'
    result = []
    if not root.exists():
        return result
    for manifest in root.rglob('dataset_manifest.json'):
        folder = manifest.parent.resolve()
        if not folder.is_relative_to(root) or not (folder / 'evaluation.json').is_file():
            continue
        metadata = folder / 'metadata.json'
        if not metadata.is_file():
            continue
        try:
            meta = json.loads(metadata.read_text('utf-8'))
        except (ValueError, OSError):
            continue
        if meta.get('status') != 'complete':
            continue
        name = folder.relative_to(root).as_posix()
        result.append(dict(id=hashlib.sha256(name.encode()).hexdigest()[:20], name=name,
                           ready=(folder / 'inspection' / 'manifest.json').is_file(),
                           finished_at=meta.get('finished_at', ''), path=folder))
    return sorted(result, key=lambda r: (r['finished_at'], r['name']), reverse=True)


def run_path(training_root, run_id):
    for run in runs(training_root):
        if run['id'] == run_id:
            return run['path']
    raise HTTPException(404, 'Unknown completed training run')


def payload(training_root, run_id):
    path = run_path(training_root, run_id) / 'inspection' / 'manifest.json'
    if not path.is_file():
        raise HTTPException(409, 'Build the saved overview for this run first')
    return json.loads(path.read_text('utf-8'))


def tile_layouts(training_root, run_id):
    """Combine retained windows with the full grid from the run's saved settings."""
    manifest = json.loads((run_path(training_root, run_id) / 'dataset_manifest.json').read_text('utf-8'))
    return _tile_layouts(manifest)


def _tile_layouts(manifest):
    config = manifest.get('config', {})
    size, overlap = config.get('tile_size'), config.get('overlap')
    complete = (isinstance(size, int) and isinstance(overlap, int)
                and size > 0 and 0 <= overlap < size)
    layouts = {source['id']: dict(
        width=source['width'], height=source['height'],
        coordinate_space=source['coordinate_space'],
        homography=(source.get('perspective') or {}).get('homography'),
        complete_grid=complete, tiles=[])
        for source in manifest.get('sources', [])}
    for tile in manifest.get('tiles', []):
        if tile['source_id'] in layouts:
            layouts[tile['source_id']]['tiles'].append({
                key: tile[key] for key in ('id', 'x', 'y', 'width', 'height', 'split')})
    if complete:
        # Match preparation's edge-anchored grid, including its final short stride.
        # Only retained tiles have saved split assignments. Do not guess a split
        # for omitted windows or use today's tiling configuration.
        def starts(length):
            last = max(0, length - size)
            return sorted({*range(0, last + 1, size - overlap), last})

        for source_id, layout in layouts.items():
            retained = {(tile['x'], tile['y']) for tile in layout['tiles']}
            for row, y in enumerate(starts(layout['height'])):
                for column, x in enumerate(starts(layout['width'])):
                    if (x, y) not in retained:
                        layout['tiles'].append(dict(
                            id=f'{source_id}__omitted_{row}_{column}', x=x, y=y,
                            width=min(size, layout['width'] - x), height=min(size, layout['height'] - y),
                            split='omitted'))
    return layouts


def latest_tile_context(training_root, doc):
    for run in runs(training_root):
        manifest = json.loads((run['path'] / 'dataset_manifest.json').read_text('utf-8'))
        source = next((source for source in manifest.get('sources', []) if source['id'] == doc.image_id), None)
        if source is None or snapshot_geometry_hash(source) != document_geometry_hash(doc):
            continue
        layout = _tile_layouts(manifest)[doc.image_id]
        if layout['tiles']:
            return dict(sourceId=doc.image_id, runName=run['name'], layout=layout, highlightedTileIds=[])
    return None


def build(training_root, python, run_id):
    run = run_path(training_root, run_id)
    try:
        process = subprocess.run([str(python), '-m', 'src.cli', 'inspect', '--run', str(run)],
                                 cwd=training_root, capture_output=True, text=True, timeout=600,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(503, f'Could not generate overview: {exc}') from exc
    if process.returncode:
        raise HTTPException(422, 'Overview generation failed: ' + (process.stderr or process.stdout)[-1500:])


def read_reviews(data_root, items):
    reviews = {}
    for source_id in {item['source_id'] for item in items}:
        # Source IDs from run snapshots must never become arbitrary server paths.
        path = (data_root / 'quality_reviews' / f'{source_id}.json').resolve()
        if not path.is_relative_to((data_root / 'quality_reviews').resolve()):
            raise HTTPException(422, 'Invalid source ID in run snapshot')
        if path.is_file():
            reviews.update(json.loads(path.read_text('utf-8'))['regions'])
    return reviews


def annotation_records(data_root, source_id):
    path = (data_root / 'annotation_reviews' / f'{source_id}.json').resolve()
    if not path.is_relative_to((data_root / 'annotation_reviews').resolve()):
        raise HTTPException(422, 'Invalid source ID in run snapshot')
    return json.loads(path.read_text('utf-8')) if path.is_file() else {}


def annotation_states(data_root, items, read_document):
    documents, records, states, indices, geometries, identities = {}, {}, {}, {}, {}, {}
    for item in items:
        if item['kind'] != 'annotation':
            continue
        source_id = item['source_id']
        if source_id not in documents:
            try:
                documents[source_id] = read_document(source_id)
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                documents[source_id] = None
            records[source_id] = annotation_records(data_root, source_id)
            doc = documents[source_id]
            points = sorted(doc.annotations, key=lambda a: a.x) if doc else []
            indices[source_id] = ([a.x for a in points], points)
            geometries[source_id] = document_geometry_hash(doc) if doc else None
            identities[source_id] = {a.id for a in points}
        doc = documents[source_id]
        status, annotation_id = 'unavailable', None
        saved = records[source_id].get(item.get('review_key'))
        if doc is not None:
            status = 'changed'
            if geometries[source_id] == item['geometry_sha256']:
                xs, points = indices[source_id]
                left, right = bisect_left(xs, item['x'] - 1e-6), bisect_right(xs, item['x'] + 1e-6)
                exact = [a for a in points[left:right] if abs(a.x - item['x']) < 1e-6
                         and abs(a.y - item['y']) < 1e-6]
                # A moved label must not be mistaken for a deleted one.
                moved = saved and saved['annotation']['id'] in identities[source_id]
                if len(exact) == 1:
                    status, annotation_id = 'present', exact[0].id
                elif not exact and not moved:
                    status = 'removed'
        states[item['id']] = dict(status=status, annotation_id=annotation_id,
                                 can_restore=status == 'removed' and bool(saved))
    return states


def save_review(data_root, training_root, run_id, item_id, reason, read_document, write_document,
                validate_points, expected_annotation_id=None):
    item = next((i for i in payload(training_root, run_id)['items'] if i['id'] == item_id), None)
    if not item or item['kind'] != 'annotation':
        raise HTTPException(422, 'Label review requires an annotation crop')
    doc = read_document(item['source_id'])
    validate_snapshot(data_root, doc, item['geometry_sha256'], item['source_sha256'])
    directory = data_root / 'annotation_reviews'
    directory.mkdir(exist_ok=True)
    path = directory / f'{doc.image_id}.json'
    saved = annotation_records(data_root, doc.image_id)
    key = item['review_key']
    state = annotation_states(data_root, [item], read_document)[item_id]
    if state['status'] == 'changed':
        raise HTTPException(409, 'Annotation changed since this run; review the current image instead')
    if reason == 'not_mite' and state['status'] == 'present' and expected_annotation_id is not None \
            and expected_annotation_id != state['annotation_id']:
        raise HTTPException(409, 'Current label changed; refresh before removing it')
    before = doc.model_dump_json(indent=2)
    changed = False
    annotation_id = state['annotation_id']
    if reason == 'not_mite' and state['status'] == 'present':
        annotation = next(a for a in doc.annotations if a.id == annotation_id)
        saved[key] = dict(annotation=annotation.model_dump(), run_id=run_id)
        doc.annotations = [a for a in doc.annotations if a.id != annotation.id]
        if annotation.source == 'model':
            doc.rejected_predictions.append(annotation.model_copy(update={'reviewed': True}))
        doc.effort.deletes += 1
        changed = True
    elif reason == 'not_mite' and not state['can_restore']:
        raise HTTPException(409, 'Annotation no longer exists at this center; refresh or inspect the current image')
    elif reason is None and state['status'] == 'removed':
        if not state['can_restore']:
            raise HTTPException(409, 'No saved label to restore; use the source editor')
        annotation = Annotation.model_validate(saved[key]['annotation'])
        if any(a.id == annotation.id for a in doc.annotations):
            raise HTTPException(409, 'Annotation ID is already in use; use the source editor')
        doc.rejected_predictions = [a for a in doc.rejected_predictions if a.id != annotation.id]
        doc.annotations.append(annotation)
        doc.review_complete = doc.review_complete and annotation.reviewed
        doc.effort.undo += 1
        annotation_id, changed = annotation.id, True
    # This focused correction preserves an already completed image review.
    validate_points(doc)
    if changed:
        history = data_root / 'history'
        history.mkdir(exist_ok=True)
        (history / f'{doc.image_id}-before-overview-review-{uuid.uuid4()}.json').write_text(before, encoding='utf-8')
        # Save the recovery record before replacing the annotation document.
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(saved, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        temporary.replace(path)
        write_document(doc)
    return dict(document=doc, annotation_id=annotation_id if reason is None else None,
                message='Label removed from the training data. Nearby labels and tiles are unchanged.'
                if reason else 'Label restored to the training data.')
