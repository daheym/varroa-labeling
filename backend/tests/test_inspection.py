import hashlib
import json
from types import SimpleNamespace

from backend.app import main
from backend.app import inspection
from backend.tests.test_api import client, upload


def setup_run(client, tmp_path, monkeypatch, corrected=False):
    doc = upload(client, corrected=corrected)
    doc['annotations'] = [{'id': 'mite-1', 'x': 20, 'y': 20, 'source': 'human', 'reviewed': True}]
    assert client.put(f"/api/images/{doc['image_id']}/annotations", json=doc).status_code == 200
    root = tmp_path / 'training'
    run = root / 'runs' / 'example'
    crops = run / 'inspection' / 'crops'
    crops.mkdir(parents=True)
    from PIL import Image
    with Image.open(main.ROOT / 'images' / f"{doc['image_id']}.png") as source:
        image = source.convert('RGB')
    digest = hashlib.sha256(str(image.size).encode() + image.tobytes()).hexdigest()
    perspective = doc['perspective'] or {}
    width, height = perspective.get('output_width', doc['original_width']), perspective.get('output_height', doc['original_height'])
    geometry = [doc['coordinate_space'], width, height, perspective.get('homography')]
    geometry_hash = hashlib.sha256(json.dumps(geometry, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    (run / 'dataset_manifest.json').write_text(json.dumps({
        'config': {'match_radius': 16}, 'sources': [{'id': doc['image_id'], 'sha256': digest,
        'width': width, 'height': height, 'coordinate_space': doc['coordinate_space'], 'perspective': doc['perspective']}] }))
    (run / 'evaluation.json').write_text('{}')
    (run / 'metadata.json').write_text('{"status":"complete"}')
    item = dict(id='mite-1', source_id=doc['image_id'], kind='annotation', x=20, y=20,
                review_key='key', geometry_sha256=geometry_hash, source_sha256=digest)
    (run / 'inspection' / 'manifest.json').write_text(json.dumps({'items': [item]}))
    image.crop((0, 0, 96, 96)).save(crops / 'mite-1.jpg')
    monkeypatch.setattr(main, 'detector', SimpleNamespace(training_root=root))
    return client.get('/api/inspection/runs').json()[0]['id'], doc


def add_prediction(tmp_path, doc, item_id='extra-1', x=90, y=50):
    path = tmp_path / 'training/runs/example/inspection/manifest.json'
    gallery = json.loads(path.read_text())
    item = dict(id=item_id, kind='prediction', source_id=doc['image_id'], x=x, y=y,
                outcomes=[{'status': 'extra', 'split': 'val', 'confidence': .87}])
    gallery['items'].append(item)
    path.write_text(json.dumps(gallery))
    return path


def test_tile_overlay_uses_saved_windows_and_crop_rounding(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch, corrected=True)
    path = tmp_path / 'training/runs/example/dataset_manifest.json'
    manifest = json.loads(path.read_text())
    tiles = [dict(id='first', source_id=doc['image_id'], x=0, y=0, width=640, height=640, split='train'),
             dict(id='overlapping', source_id=doc['image_id'], x=512, y=0, width=640, height=640, split='val')]
    manifest['tiles'] = tiles
    path.write_text(json.dumps(manifest))
    add_prediction(tmp_path, doc, x=48.5, y=49.5)
    response = client.get(f'/api/inspection/runs/{run_id}')
    assert response.status_code == 200
    data = response.json()
    layout = data['tile_layouts'][doc['image_id']]
    assert layout['tiles'] == [{key: value for key, value in tile.items() if key != 'source_id'} for tile in tiles]
    assert layout['coordinate_space'] == 'canonical'
    assert layout['complete_grid'] is False
    assert layout['homography'] == doc['perspective']['homography']
    assert data['items'][-1]['crop_bounds'] == dict(x=0, y=2, width=96, height=96)
    # Geometry is read without rewriting the saved training artifacts.
    assert json.loads(path.read_text()) == manifest
    context = client.get(f"/api/images/{doc['image_id']}/tiles").json()
    assert context['layout'] == layout
    assert context['highlightedTileIds'] == []
    doc['perspective']['homography'][0][0] += 1
    main.write(main.Document.model_validate(doc))
    assert client.get(f"/api/images/{doc['image_id']}/tiles").json() is None


def test_tile_overlay_handles_runs_without_saved_tiles(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch)
    assert client.get(f'/api/inspection/runs/{run_id}').json()['tile_layouts'][doc['image_id']]['tiles'] == []
    assert client.get(f"/api/images/{doc['image_id']}/tiles").json() is None
    assert client.get('/api/images/missing/tiles').status_code == 404


def test_complete_grid_preserves_split_membership_and_covers_edges():
    source = dict(id='board', width=1500, height=1000, coordinate_space='original')
    saved = [dict(id='train', source_id='board', x=0, y=0, width=640, height=640, split='train'),
             dict(id='val', source_id='board', x=860, y=360, width=640, height=640, split='val')]
    manifest = dict(config=dict(tile_size=640, overlap=128), sources=[source], tiles=saved)
    layout = inspection._tile_layouts(manifest)['board']
    assert layout['complete_grid'] is True
    assert len(layout['tiles']) == 6
    assert layout['tiles'][:2] == [{key: value for key, value in tile.items() if key != 'source_id'} for tile in saved]
    omitted = [tile for tile in layout['tiles'] if tile['split'] == 'omitted']
    assert {(tile['x'], tile['y']) for tile in omitted} == {(512, 0), (860, 0), (0, 360), (512, 360)}
    assert all(tile['width'] == 640 and tile['height'] == 640 for tile in omitted)
    # The complete grid covers every region between its boundaries, including
    # the anchored right/bottom edges and overlaps next to omitted windows.
    xs = sorted({0, 1500, *(tile['x'] for tile in layout['tiles']), *(tile['x'] + tile['width'] for tile in layout['tiles'])})
    ys = sorted({0, 1000, *(tile['y'] for tile in layout['tiles']), *(tile['y'] + tile['height'] for tile in layout['tiles'])})
    for left, right in zip(xs, xs[1:]):
        for top, bottom in zip(ys, ys[1:]):
            x, y = (left + right) / 2, (top + bottom) / 2
            assert any(t['x'] <= x < t['x'] + t['width'] and t['y'] <= y < t['y'] + t['height'] for t in layout['tiles'])
    assert all('source_id' in tile for tile in saved)  # The input snapshot is unchanged.


def test_complete_grid_handles_small_sources_and_invalid_saved_settings():
    source = dict(id='small', width=300, height=200, coordinate_space='original')
    manifest = dict(config=dict(tile_size=640, overlap=128), sources=[source], tiles=[])
    layout = inspection._tile_layouts(manifest)['small']
    assert layout['complete_grid'] is True
    assert layout['tiles'] == [dict(id='small__omitted_0_0', x=0, y=0, width=300, height=200, split='omitted')]
    manifest['config']['overlap'] = 640
    layout = inspection._tile_layouts(manifest)['small']
    assert layout['complete_grid'] is False
    assert layout['tiles'] == []


def test_overview_removes_only_one_label_and_preserves_completed_review(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch, corrected=True)
    url = f'/api/inspection/runs/{run_id}'
    assert client.get(url).json()['reviews'] == {}
    assert client.get(url + '/crops/mite-1.jpg').headers['content-type'] == 'image/jpeg'
    assert client.get(url + '/crops/missing.jpg').status_code == 404
    assert client.get('/api/inspection/runs/unknown').status_code == 404
    base = f"/api/images/{doc['image_id']}"
    doc['review_complete'] = True
    doc['annotations'].append(dict(id='neighbor', x=21, y=20, source='human', reviewed=True))
    doc = client.put(base + '/annotations', json=doc).json()
    gallery = tmp_path / 'training/runs/example/inspection/manifest.json'
    before_gallery = gallery.read_bytes()
    review = dict(run_id=run_id, item_id='mite-1', reason='not_mite')
    response = client.put('/api/inspection/review', json=review)
    assert response.status_code == 200
    assert response.json()['document']['review_complete'] is True
    updated = client.get(base).json()
    assert updated['annotations'] == [doc['annotations'][1]]
    assert updated['effort']['deletes'] == 1
    state = client.get(url).json()['annotation_states']['mite-1']
    assert state == dict(status='removed', annotation_id=None, can_restore=True)
    assert client.get(base + '/export').json()['annotations'] == [doc['annotations'][1]]
    assert not (main.ROOT / 'quality_reviews').exists()
    assert gallery.read_bytes() == before_gallery
    assert len(list((main.ROOT / 'history').glob('*before-overview-review-*.json'))) == 1
    # Retry is idempotent, even with a valid mite just one pixel away.
    assert client.put('/api/inspection/review', json=review).status_code == 200
    assert client.get(base).json() == updated
    assert client.put('/api/inspection/review', json={**review, 'reason': 'unknown'}).status_code == 422
    assert client.put('/api/inspection/review', json={**review, 'reason': 'poor_quality'}).status_code == 422
    restored = client.put('/api/inspection/review', json={**review, 'reason': None})
    assert restored.status_code == 200
    assert restored.json()['annotation_states']['mite-1']['status'] == 'present'
    assert restored.json()['document']['review_complete'] is True
    assert {a['id'] for a in restored.json()['document']['annotations']} == {'mite-1', 'neighbor'}
    assert client.get(url).json()['reviews'] == {}


def test_quality_review_refuses_stale_coordinates(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch)
    doc['annotations'][0]['x'] = 21
    assert client.put(f"/api/images/{doc['image_id']}/annotations", json=doc).status_code == 200
    response = client.put('/api/inspection/review', json=dict(run_id=run_id, item_id='mite-1', reason='not_mite'))
    assert response.status_code == 409


def test_overview_removal_refuses_replaced_label_and_reset_clears_restore(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch)
    body = dict(run_id=run_id, item_id='mite-1', reason='not_mite')
    assert client.put('/api/inspection/review', json={**body, 'expected_annotation_id': 'different-id'}).status_code == 409
    assert len(main.read(doc['image_id']).annotations) == 1
    assert client.put('/api/inspection/review', json=body).status_code == 200
    assert client.post(f"/api/images/{doc['image_id']}/annotations/reset").status_code == 200
    state = client.get(f'/api/inspection/runs/{run_id}').json()['annotation_states']['mite-1']
    assert state['status'] == 'removed' and state['can_restore'] is False
    assert client.put('/api/inspection/review', json={**body, 'reason': None}).status_code == 409


def test_removed_model_label_is_rejected_and_restored_with_provenance(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch)
    base = f"/api/images/{doc['image_id']}"
    doc['annotations'][0].update(source='model', confidence=.8, model_version='original-model')
    client.put(base + '/annotations', json=doc)
    original = client.get(base).json()['annotations'][0]
    body = dict(run_id=run_id, item_id='mite-1', reason='not_mite')
    removed = client.put('/api/inspection/review', json=body).json()['document']
    assert removed['annotations'] == []
    assert removed['rejected_predictions'] == [original]
    assert removed['review_complete'] is False
    restored = client.put('/api/inspection/review', json={**body, 'reason': None}).json()['document']
    assert restored['annotations'] == [original]
    assert restored['rejected_predictions'] == []


def test_current_dataset_drives_removed_badge_and_legacy_flags_do_not_delete(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch)
    directory = main.ROOT / 'quality_reviews'
    directory.mkdir()
    (directory / f"{doc['image_id']}.json").write_text(json.dumps({
        'schema_version': 1, 'regions': {'key': {'reason': 'not_mite'}}}))
    url = f'/api/inspection/runs/{run_id}'
    result = client.get(url).json()
    assert result['reviews']['key']['reason'] == 'not_mite'
    assert result['annotation_states']['mite-1']['status'] == 'present'
    doc['annotations'] = []
    client.put(f"/api/images/{doc['image_id']}/annotations", json=doc)
    state = client.get(url).json()['annotation_states']['mite-1']
    assert state == dict(status='removed', annotation_id=None, can_restore=False)


def test_overview_refuses_changed_source_or_perspective_and_moved_restore(client, tmp_path, monkeypatch):
    from PIL import Image
    run_id, doc = setup_run(client, tmp_path, monkeypatch, corrected=True)
    body = dict(run_id=run_id, item_id='mite-1', reason='not_mite')
    assert client.put('/api/inspection/review', json=body).status_code == 200
    assert client.put('/api/inspection/review', json={**body, 'reason': None}).status_code == 200
    saved = main.read(doc['image_id'])
    saved.annotations[0].x += 1
    main.write(saved)
    assert client.put('/api/inspection/review', json=body).status_code == 409
    assert client.put('/api/inspection/review', json={**body, 'reason': None}).status_code == 409
    saved.annotations[0].x -= 1
    saved.perspective['homography'][0][0] += .1
    main.write(saved)
    assert client.put('/api/inspection/review', json=body).status_code == 409
    saved.perspective['homography'][0][0] -= .1
    main.write(saved)
    Image.new('RGB', (120, 80), 'black').save(main.ROOT / 'images' / f"{doc['image_id']}.png")
    assert client.put('/api/inspection/review', json=body).status_code == 409


def test_confirm_mite_adds_reviewed_label_and_deduplicates_overlapping_predictions(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch, corrected=True)
    doc['review_complete'] = True
    base = f"/api/images/{doc['image_id']}"
    assert client.put(base + '/annotations', json=doc).status_code == 200
    gallery_path = add_prediction(tmp_path, doc)
    add_prediction(tmp_path, doc, item_id='overlapping-extra', x=94, y=52)
    before_gallery = gallery_path.read_bytes()
    body = dict(run_id=run_id, item_id='extra-1')
    response = client.post('/api/inspection/confirm-mite', json=body)
    assert response.status_code == 200
    result = response.json()
    assert result['added'] is True
    updated = client.get(base).json()
    assert len(updated['annotations']) == 2
    annotation = next(a for a in updated['annotations'] if a['id'] == result['annotation_id'])
    assert (annotation['x'], annotation['y']) == (90, 50)
    assert annotation['source'] == 'model' and annotation['reviewed'] is True
    assert annotation['confidence'] == .87 and annotation['model_version'] == 'inspection:example'
    assert updated['review_complete'] is False and updated['effort']['accepts'] == 1
    assert len(list((main.ROOT / 'history').glob('*before-confirm-mite-*.json'))) == 1
    # Same request and a different overlapping tile both reuse the accepted label.
    for item_id in ('extra-1', 'overlapping-extra'):
        repeated = client.post('/api/inspection/confirm-mite', json={**body, 'item_id': item_id}).json()
        assert repeated['added'] is False and repeated['annotation_id'] == annotation['id']
    assert len(client.get(base).json()['annotations']) == 2
    assert client.get(base).json()['effort']['accepts'] == 1
    confirmed = client.get(f'/api/inspection/runs/{run_id}').json()['confirmed_predictions']
    assert confirmed == {'extra-1': annotation['id'], 'overlapping-extra': annotation['id']}
    assert gallery_path.read_bytes() == before_gallery  # Historical predictions stay unchanged.
    # The new point is also a valid reviewed training/export label.
    updated['review_complete'] = True
    assert client.put(base + '/annotations', json=updated).status_code == 200
    exported = client.get(base + '/export').json()
    assert any(a['id'] == annotation['id'] and a['reviewed'] for a in exported['annotations'])


def test_confirm_mite_accepts_existing_pending_label_without_changing_provenance(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch)
    doc['annotations'].append(dict(id='pending', x=92, y=50, source='model', reviewed=False,
                                   confidence=.6, model_version='previous-model'))
    base = f"/api/images/{doc['image_id']}"
    assert client.put(base + '/annotations', json=doc).status_code == 200
    add_prediction(tmp_path, doc)
    result = client.post('/api/inspection/confirm-mite', json=dict(run_id=run_id, item_id='extra-1')).json()
    assert result['added'] is False and result['annotation_id'] == 'pending'
    saved = next(a for a in client.get(base).json()['annotations'] if a['id'] == 'pending')
    assert saved['reviewed'] is True and saved['model_version'] == 'previous-model' and saved['confidence'] == .6
    assert (saved['x'], saved['y']) == (92, 50)


def test_confirm_mite_rejects_changed_source_and_out_of_bounds_and_annotation_crops(client, tmp_path, monkeypatch):
    from PIL import Image
    run_id, doc = setup_run(client, tmp_path, monkeypatch)
    add_prediction(tmp_path, doc, x=125)
    body = dict(run_id=run_id, item_id='extra-1')
    assert client.post('/api/inspection/confirm-mite', json=body).status_code == 422
    assert client.post('/api/inspection/confirm-mite', json={**body, 'item_id': 'mite-1'}).status_code == 422
    add_prediction(tmp_path, doc, item_id='in-bounds')
    Image.new('RGB', (120, 80), 'black').save(main.ROOT / 'images' / f"{doc['image_id']}.png")
    assert client.post('/api/inspection/confirm-mite', json={**body, 'item_id': 'in-bounds'}).status_code == 409
    assert len(client.get(f"/api/images/{doc['image_id']}").json()['annotations']) == 1


def test_confirm_mite_rejects_changed_perspective(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch, corrected=True)
    add_prediction(tmp_path, doc)
    saved = main.read(doc['image_id'])
    saved.perspective['homography'][0][0] += .1
    main.write(saved)
    response = client.post('/api/inspection/confirm-mite', json=dict(run_id=run_id, item_id='extra-1'))
    assert response.status_code == 409


def test_prediction_review_tracks_progress_without_changing_training_data(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch)
    gallery_path = add_prediction(tmp_path, doc)
    annotation_path = main.path(doc['image_id'])
    before_annotation = annotation_path.read_bytes()
    before_gallery = gallery_path.read_bytes()
    body = dict(run_id=run_id, item_id='extra-1', decision='not_mite')
    url = f'/api/inspection/runs/{run_id}'
    assert client.get(url).json()['prediction_reviews'] == {}
    response = client.put('/api/inspection/prediction-review', json=body)
    assert response.status_code == 200
    assert response.json()['prediction_reviews']['extra-1']['decision'] == 'not_mite'
    # Read back from disk, with per-run progress preserved across reloads.
    stored = main.ROOT / 'inspection_reviews' / f'{run_id}.json'
    assert json.loads(stored.read_text())['predictions']['extra-1']['source_id'] == doc['image_id']
    assert client.get(url).json()['prediction_reviews']['extra-1']['decision'] == 'not_mite'
    assert annotation_path.read_bytes() == before_annotation
    assert gallery_path.read_bytes() == before_gallery
    assert not (main.ROOT / 'quality_reviews').exists()
    # Clearing a decision returns this crop to the review queue without editing labels.
    assert client.put('/api/inspection/prediction-review', json={**body, 'decision': None}).json()['prediction_reviews'] == {}
    assert client.get(url).json()['prediction_reviews'] == {}
    assert annotation_path.read_bytes() == before_annotation


def test_prediction_review_is_separate_for_each_run_and_rejects_annotation_crops(client, tmp_path, monkeypatch):
    import shutil
    run_id, doc = setup_run(client, tmp_path, monkeypatch)
    add_prediction(tmp_path, doc)
    body = dict(run_id=run_id, item_id='extra-1', decision='not_mite')
    assert client.put('/api/inspection/prediction-review', json=body).status_code == 200
    shutil.copytree(tmp_path / 'training/runs/example', tmp_path / 'training/runs/another-run')
    other_id = next(run['id'] for run in client.get('/api/inspection/runs').json() if run['name'] == 'another-run')
    assert client.get(f'/api/inspection/runs/{other_id}').json()['prediction_reviews'] == {}
    assert client.put('/api/inspection/prediction-review', json={**body, 'item_id': 'mite-1'}).status_code == 422
    assert client.put('/api/inspection/prediction-review', json={**body, 'decision': 'poor_quality'}).status_code == 422
    assert client.put('/api/inspection/prediction-review', json={**body, 'run_id': 'unknown'}).status_code == 404


def test_confirming_previously_rejected_prediction_clears_review_mark(client, tmp_path, monkeypatch):
    run_id, doc = setup_run(client, tmp_path, monkeypatch)
    add_prediction(tmp_path, doc)
    body = dict(run_id=run_id, item_id='extra-1')
    assert client.put('/api/inspection/prediction-review', json={**body, 'decision': 'not_mite'}).status_code == 200
    response = client.post('/api/inspection/confirm-mite', json=body)
    assert response.status_code == 200 and response.json()['added'] is True
    assert response.json()['prediction_reviews'] == {}
    assert 'extra-1' in response.json()['confirmed_predictions']
    # A linked label must be explicitly confirmed before it can be removed.
    before = main.path(doc['image_id']).read_bytes()
    assert client.put('/api/inspection/prediction-review', json={**body, 'decision': 'not_mite'}).status_code == 409
    assert main.path(doc['image_id']).read_bytes() == before
    saved = main.read(doc['image_id'])
    saved.review_complete = True
    main.write(saved)
    label_id = response.json()['annotation_id']
    rejected = client.put('/api/inspection/prediction-review', json={**body, 'decision': 'not_mite',
                          'expected_annotation_id': label_id})
    assert rejected.status_code == 200
    assert rejected.json()['document']['review_complete'] is True
    assert [a['id'] for a in rejected.json()['document']['annotations']] == ['mite-1']
    assert rejected.json()['confirmed_predictions'] == {}
