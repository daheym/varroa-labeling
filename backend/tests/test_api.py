import io
import json
import numpy as np
import pytest
from PIL import Image
from fastapi.testclient import TestClient
from backend.app import main
from backend.app.detector import UnconfiguredDetector


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, 'ROOT', tmp_path)
    for folder in ('images', 'annotations', 'corrected'):
        (tmp_path / folder).mkdir()
    monkeypatch.setattr(main, 'detector', UnconfiguredDetector())
    return TestClient(main.app)


def upload(client, corrected=True):
    data = io.BytesIO()
    Image.new('RGB', (120, 80), 'white').save(data, format='PNG')
    r = client.post('/api/images', files={'file': ('sample.png', data.getvalue(), 'image/png')})
    assert r.status_code == 200
    doc = r.json()
    assert client.get(f"/api/images/{doc['image_id']}/original").content == data.getvalue()
    if corrected:
        doc = client.post(f"/api/images/{doc['image_id']}/perspective", json={
            'corners': [{'x':0,'y':0},{'x':119,'y':0},{'x':119,'y':79},{'x':0,'y':79}],
            'physical_width_mm':15, 'physical_height_mm':10}).json()
    return doc


def test_review_persistence_and_export(client):
    doc = upload(client)
    base = f"/api/images/{doc['image_id']}"
    point = {'id': 'p1', 'x': 10.5, 'y': 20.25, 'className': 'varroa', 'source': 'model', 'confidence': .8, 'reviewed': False}
    r = client.post(base+'/candidates', json={'model_version': 'detector-v1', 'coordinate_space':'canonical', 'perspective_file':doc['perspective']['file'], 'annotations': [point]})
    assert r.status_code == 200
    doc = r.json()
    assert client.get(base+'/export').status_code == 409
    doc['annotations'][0]['reviewed'] = True
    assert client.put(base+'/annotations', json=doc).status_code == 200
    assert client.get(base+'/export').json()['model_version'] == 'detector-v1'
    assert json.loads(main.path(doc['image_id']).read_text())['annotations'][0]['x'] == 10.5
    doc['annotations'][0]['x'] = doc['perspective']['output_width']
    assert client.put(base+'/annotations', json=doc).status_code == 422
    assert client.post(base+'/candidates', json={'model_version': 'v2', 'coordinate_space':'canonical', 'perspective_file':doc['perspective']['file'], 'annotations': []}).status_code == 409


def test_perspective_metadata_and_original(client):
    doc = upload(client)
    base = f"/api/images/{doc['image_id']}"
    original = client.get(base+'/original').content
    corners = [{'x': 10, 'y': 10}, {'x': 100, 'y': 5}, {'x': 110, 'y': 70}, {'x': 5, 'y': 75}]
    r = client.post(base+'/perspective', json={'corners': corners, 'physical_width_mm':15, 'physical_height_mm':10})
    assert r.status_code == 200
    p = r.json()['perspective']
    h = np.array(p['homography'])
    for src, dest in zip(corners, [(0,0), (p['width'],0), (p['width'],p['height']), (0,p['height'])]):
        q = h @ [src['x'], src['y'], 1]
        assert np.allclose(q[:2]/q[2], dest)
    assert client.get(base+'/corrected').status_code == 200
    assert client.get(base+'/original').content == original
    assert client.post(base+'/perspective', json={'corners': [corners[0]]*4}).status_code == 422
    # Stale annotation snapshots must not erase server-owned perspective metadata.
    assert client.put(base+'/annotations', json=doc).status_code == 409


def test_validation_and_placeholders(client):
    doc = upload(client)
    assert client.get('/api/models').json() == {'models': [], 'status': 'unconfigured'}
    assert client.get('/api/models/train').json()['state'] == 'unavailable'
    assert client.post('/api/models/train').status_code == 409
    doc['review_complete'] = True
    assert client.put(f"/api/images/{doc['image_id']}/annotations", json=doc).status_code == 200
    assert client.post('/api/models/train').status_code == 503
    assert client.post(f"/api/images/{doc['image_id']}/predict", json={'model_id': 'missing'}).status_code == 503
    assert client.get('/api/images/not-an-id').status_code == 404
    assert client.post('/api/images', files={'file': ('bad.png', b'bad', 'image/png')}).status_code == 415


def test_start_training_requires_complete_normalized_dataset(client, monkeypatch):
    doc = upload(client)

    class FakeTrainer:
        status = 'ready'
        def models(self): return []
        def training_status(self): return {'state': 'idle', 'message': 'Ready'}
        def start_training(self, data_root):
            assert data_root == main.ROOT
            return {'state': 'running', 'message': 'Started', 'pid': 123}

    monkeypatch.setattr(main, 'detector', FakeTrainer())
    response = client.post('/api/models/train')
    assert response.status_code == 409
    assert 'Mark every image review complete' in response.json()['detail']

    doc['review_complete'] = True
    assert client.put(f"/api/images/{doc['image_id']}/annotations", json=doc).status_code == 200
    response = client.post('/api/models/train')
    assert response.status_code == 200
    assert response.json()['state'] == 'running'


def test_predict_uses_selected_model_and_persists_candidates(client, monkeypatch):
    doc = upload(client)

    class FakeDetector:
        status = 'ready'

        def models(self):
            return [{'id': 'runs/demo/yolo/weights/best.pt', 'label': 'demo best', 'model_version': 'demo@abc123'}]

        def predict(self, image_path, *, perspective, model_id):
            assert image_path.exists()
            assert perspective['file'] == doc['perspective']['file']
            assert model_id == 'runs/demo/yolo/weights/best.pt'
            from backend.app.models import Annotation, Candidates
            return Candidates(
                model_version='demo@abc123',
                coordinate_space='canonical',
                perspective_file=perspective['file'],
                annotations=[Annotation(
                    id='pred_demo', x=22.5, y=31.25, source='model', confidence=.91,
                    model_version='demo@abc123', reviewed=False,
                    bbox={'x': 10, 'y': 12, 'width': 5, 'height': 6},
                )],
            )

    monkeypatch.setattr(main, 'detector', FakeDetector())
    registry = client.get('/api/models').json()
    assert registry['status'] == 'ready'
    assert registry['models'][0]['id'] == 'runs/demo/yolo/weights/best.pt'
    response = client.post(f"/api/images/{doc['image_id']}/predict", json={'model_id': registry['models'][0]['id']})
    assert response.status_code == 200, response.text
    predicted = response.json()
    assert predicted['model_version'] == 'demo@abc123'
    assert predicted['annotations'][0]['x'] == 22.5
    assert predicted['annotations'][0]['confidence'] == .91
    assert predicted['annotations'][0]['reviewed'] is False
    assert json.loads((main.ROOT / 'prediction_history' / f"{doc['image_id']}.json").read_text())['annotations'][0]['source'] == 'model'
    assert client.post(f"/api/images/{doc['image_id']}/predict", json={'model_id': registry['models'][0]['id']}).status_code == 409


def test_predict_requires_current_physical_correction(client, monkeypatch):
    doc = upload(client, corrected=False)

    class MustNotPredict:
        status = 'ready'
        def models(self): return [{'id': 'model', 'label': 'model', 'model_version': 'model-v1'}]
        def predict(self, *args, **kwargs): raise AssertionError('inference must not run without correction')

    monkeypatch.setattr(main, 'detector', MustNotPredict())
    response = client.post(f"/api/images/{doc['image_id']}/predict", json={'model_id': 'model'})
    assert response.status_code == 409
    assert 'perspective correction' in response.json()['detail']


def test_exif_orientation(client):
    stream = io.BytesIO()
    image = Image.new('RGB', (120, 80))
    exif = image.getexif()
    exif[274] = 6
    image.save(stream, format='JPEG', exif=exif)
    doc = client.post('/api/images', files={'file': ('phone.jpg', stream.getvalue(), 'image/jpeg')}).json()
    assert (doc['original_width'], doc['original_height']) == (80, 120)


def seeded_document(client):
    doc = upload(client)
    doc['annotations'] = [{'id': 'human', 'x': 10, 'y': 20, 'source': 'human', 'reviewed': True}]
    doc['rejected_predictions'] = [{'id': 'model', 'x': 20, 'y': 30, 'source': 'model', 'reviewed': True}]
    doc['model_version'] = 'v1'
    doc['effort']['manual_adds'] = 3
    doc['dataset_version'] = 'experiment-2'
    return client.put(f"/api/images/{doc['image_id']}/annotations", json=doc).json()


def test_reset_current_preserves_other_images_and_perspective(client):
    first, second = seeded_document(client), seeded_document(client)
    base = f"/api/images/{first['image_id']}"
    corners = [{'x': 0, 'y': 0}, {'x': 119, 'y': 0}, {'x': 119, 'y': 79}, {'x': 0, 'y': 79}]
    perspective = client.post(base+'/perspective', json={'corners': corners, 'physical_width_mm':15, 'physical_height_mm':10}).json()['perspective']
    original = client.get(base+'/original').content
    result = client.post(base+'/annotations/reset')
    assert result.status_code == 200
    doc = result.json()
    assert doc['annotations'] == doc['rejected_predictions'] == []
    assert doc['model_version'] is None
    assert all(v == 0 for v in doc['effort'].values())
    assert doc['perspective'] == perspective
    assert doc['dataset_version'] == 'experiment-2'
    assert client.get(base+'/original').content == original
    assert client.get(base+'/corrected').status_code == 200
    assert client.get(f"/api/images/{second['image_id']}").json() == second
    assert client.post(base+'/candidates', json={'model_version': 'v2', 'coordinate_space':'canonical', 'perspective_file':doc['perspective']['file'], 'annotations': []}).status_code == 200


def test_reset_all_requires_confirmation_and_persists(client):
    docs = [seeded_document(client), seeded_document(client)]
    for payload in ({}, {'confirmation': 'reset all'}):
        assert client.post('/api/annotations/reset-all', json=payload).status_code == 422
    assert client.get(f"/api/images/{docs[0]['image_id']}").json() == docs[0]
    assert client.post('/api/annotations/reset-all', json={'confirmation': 'RESET ALL'}).json() == {'reset_images': 2}
    for original in docs:
        doc = client.get(f"/api/images/{original['image_id']}").json()
        assert doc['annotations'] == doc['rejected_predictions'] == []
        assert doc['model_version'] is None
        assert all(v == 0 for v in doc['effort'].values())
        assert client.get(f"/api/images/{doc['image_id']}/file").status_code == 200
        assert json.loads(main.path(doc['image_id']).read_text()) == doc


def test_delete_image_removes_its_dataset_files_and_history(client):
    doc = upload(client)
    other = upload(client)
    image_id = doc['image_id']

    # A second correction archives the previous document and leaves two
    # corrected rasters associated with this image.
    base = f"/api/images/{image_id}"
    corners = [{'x': 0, 'y': 0}, {'x': 119, 'y': 0}, {'x': 119, 'y': 79}, {'x': 0, 'y': 79}]
    assert client.post(base+'/perspective', json={
        'corners': corners, 'physical_width_mm': 15, 'physical_height_mm': 10,
    }).status_code == 200

    prediction_history = main.ROOT / 'prediction_history'
    prediction_history.mkdir(exist_ok=True)
    (prediction_history / f'{image_id}.json').write_text('{}', encoding='utf-8')
    (prediction_history / f'{image_id}.before.json').write_text('{}', encoding='utf-8')
    (prediction_history / f"{other['image_id']}.json").write_text('{}', encoding='utf-8')
    unrelated_history = main.ROOT / 'history' / 'unrelated.json'
    unrelated_history.parent.mkdir(exist_ok=True)
    unrelated_history.write_text('{}', encoding='utf-8')

    response = client.delete(base)
    assert response.status_code == 200
    assert response.json() == {'deleted_image_id': image_id}
    assert client.get(base).status_code == 404
    assert image_id not in {item['image_id'] for item in client.get('/api/images').json()}
    assert not main.path(image_id).exists()
    assert not (main.ROOT / 'images' / f'{image_id}.original').exists()
    assert not (main.ROOT / 'images' / f'{image_id}.png').exists()
    assert not list((main.ROOT / 'corrected').glob(f'{image_id}-*.png'))
    assert not list((main.ROOT / 'history').glob(f'{image_id}-*.json'))
    assert not list(prediction_history.glob(f'{image_id}*.json'))
    assert (main.ROOT / 'images' / f"{other['image_id']}.png").exists()
    assert (prediction_history / f"{other['image_id']}.json").exists()
    assert unrelated_history.exists()
    assert client.delete(base).status_code == 404
