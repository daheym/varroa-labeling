import json
import numpy as np
import pytest
from backend.app import main
from backend.app.perspective import build_transform, transform_points
from backend.tests.test_api import client, upload


def payload(width=15,height=10):
    return dict(corners=[dict(x=x,y=y) for x,y in [(0,0),(119,0),(119,79),(0,79)]],
                physical_width_mm=width,physical_height_mm=height)


def test_legacy_migration_and_recorrection_preserve_points(client):
    doc=upload(client,corrected=False)
    doc['annotations']=[dict(id='a',x=59.5,y=39.5,source='human',reviewed=True)]
    # Existing original-coordinate data can now be edited and exchanged directly.
    main.path(doc['image_id']).write_text(json.dumps(doc))
    base=f"/api/images/{doc['image_id']}"
    assert client.put(base+'/annotations',json=doc).status_code == 200
    result=client.post(base+'/perspective',json=payload())
    assert result.status_code == 200
    migrated=result.json()
    assert migrated['coordinate_space']=='canonical'
    assert (migrated['annotations'][0]['x'],migrated['annotations'][0]['y']) == pytest.approx((7.5 * main.NORMALIZATION["pixels_per_mm"], 5 * main.NORMALIZATION["pixels_per_mm"]))
    second=client.post(base+'/perspective',json=payload(30,20)).json()
    assert (second['annotations'][0]['x'],second['annotations'][0]['y']) == pytest.approx((15 * main.NORMALIZATION["pixels_per_mm"], 10 * main.NORMALIZATION["pixels_per_mm"]))
    archives=[json.loads(p.read_text()) for p in (main.ROOT/'history').glob('*.json')]
    assert any(a["annotations"][0]["x"] == 59.5 and a["coordinate_space"] == "original" for a in archives)
    assert client.put(base+'/annotations',json=migrated).status_code==409


def test_outside_region_and_missing_dimensions_preserve_document(client):
    doc=upload(client,corrected=False)
    doc['annotations']=[dict(id='a',x=5,y=5,source='human',reviewed=True)]
    main.path(doc['image_id']).write_text(json.dumps(doc))
    base=f"/api/images/{doc['image_id']}"
    body=payload(); body['corners']=[dict(x=x,y=y) for x,y in [(20,20),(100,20),(100,70),(20,70)]]
    assert client.post(base+'/perspective',json=body).status_code==422
    assert client.get(base).json()['coordinate_space']=='original'
    assert client.post(base+'/perspective',json={'corners':payload()['corners']}).status_code==422
    assert client.get(base+'/export').status_code==409


def test_profiles_quality_and_candidate_contract(client,monkeypatch):
    monkeypatch.setattr(main,'NORMALIZATION',dict(pixels_per_mm=8,min_source_scale_ratio=.75,quality_policy='warn',
        board_profiles={'small':dict(physical_width_mm=30,physical_height_mm=20)}))
    doc=upload(client,corrected=False);base=f"/api/images/{doc['image_id']}"
    body=dict(corners=payload()['corners'],board_profile='small')
    result=client.post(base+'/perspective',json=body).json()
    assert result['perspective']['quality_warning']
    assert result['perspective']['output_width']==240
    assert client.post(base+'/candidates',json=dict(model_version='v1',annotations=[])).status_code==422
    main.NORMALIZATION['quality_policy']='error'
    assert client.post(base+'/perspective',json=body).status_code==422


def test_corner_order_forward_inverse_and_scale():
    for width,height,scale in [(400,600,2),(300,500,4)]:
        corners=[(10,10),(10+width*scale,10),(10+width*scale,10+height*scale),(10,10+height*scale)]
        p=build_transform(corners,5000,5000,width,height)
        assert transform_points([(10+50*scale,10+70*scale)],p['homography'])[0]==pytest.approx((400,560))
        assert transform_points([(400,560)],p['inverse_homography'])[0]==pytest.approx((10+50*scale,10+70*scale))
        with pytest.raises(ValueError,match='clockwise'):
            build_transform(corners[::-1],5000,5000,width,height)
