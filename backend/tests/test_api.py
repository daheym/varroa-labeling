import io
import json
import numpy as np
import pytest
from PIL import Image
from fastapi.testclient import TestClient
from backend.app import main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, 'ROOT', tmp_path)
    for folder in ('images', 'annotations', 'corrected'):
        (tmp_path / folder).mkdir()
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
    doc['annotations'][0]['x'] = 120
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
    assert client.get('/api/models').json()['models'] == []
    assert client.post('/api/models/train').status_code == 501
    assert client.post(f"/api/images/{doc['image_id']}/predict").status_code == 501
    assert client.get('/api/images/not-an-id').status_code == 404
    assert client.post('/api/images', files={'file': ('bad.png', b'bad', 'image/png')}).status_code == 415


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
