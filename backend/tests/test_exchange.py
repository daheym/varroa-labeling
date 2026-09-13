import io
import json
import copy
import pytest
from PIL import Image
from fastapi.testclient import TestClient
from backend.app import main
from backend.app.interchange import load_bundle, dump, AnnotationFile, Manifest
from backend.app.exchange import original_annotations

@pytest.fixture
def client(tmp_path,monkeypatch):
    root=tmp_path/"store"
    for folder in ("images","annotations","corrected"):(root/folder).mkdir(parents=True)
    monkeypatch.setattr(main,"ROOT",root)
    return TestClient(main.app)

def upload(client):
    data=io.BytesIO();Image.new("RGB",(120,80),"white").save(data,format="PNG")
    doc=client.post("/api/images",files={"file":("photo.png",data.getvalue(),"image/png")}).json()
    return doc,data.getvalue()

def export(client,doc,output,purpose="unreviewed"):
    return client.post("/api/exchange/export",json={"directory":str(output),"dataset_version":"test-1",
        "purpose":purpose,"image_ids":[doc["image_id"]]})

def predictions(client,doc,tmp_path):
    root=tmp_path/"pool";assert export(client,doc,root).status_code==200
    manifest,docs=load_bundle(root)
    output=tmp_path/"predictions"
    payload=docs[0].model_dump(by_alias=True)
    payload["annotations"]=[{"id":f"pred_{i}","class":"varroa","x":10.125+i*20,"y":20.25,
        "bbox":{"x":8+i*20,"y":18,"width":6,"height":5},"source":"model","confidence":.87,
        "model_version":"varroa-v3","reviewed":False} for i in range(3)]
    dump(output/"annotations"/(doc["image_id"]+".json"),payload,AnnotationFile)
    m=manifest.model_dump();m["purpose"]="predictions"
    dump(output/"manifest.json",m,Manifest)
    response=client.post("/api/exchange/import",json={"directory":str(output)})
    assert response.status_code==200,response.text
    return response.json()[0],payload

def test_review_roundtrip_stats_and_original_bytes(client,tmp_path):
    doc,original=upload(client)
    assert export(client,doc,tmp_path/"unsafe","ground_truth").status_code==422
    doc,baseline=predictions(client,doc,tmp_path)
    assert export(client,doc,tmp_path/"unsafe2","ground_truth").status_code==422
    doc["annotations"][0]["reviewed"]=True
    doc["annotations"][1].update(x=31.5,reviewed=True,bbox=None)
    rejected=doc["annotations"].pop();rejected["reviewed"]=True
    doc["rejected_predictions"].append(rejected)
    doc["annotations"].append({"id":"human_added","className":"varroa","source":"human","x":80.5,"y":40.25,"reviewed":True})
    doc["review_complete"]=True
    response=client.put(f"/api/images/{doc['image_id']}/annotations",json=doc)
    assert response.status_code==200,response.text
    root=tmp_path/"ground-truth"
    assert export(client,doc,root,"ground_truth").status_code==200
    _,docs=load_bundle(root,training=True)
    assert (root/"images"/docs[0].image.filename).read_bytes()==original
    accepted,corrected,human=docs[0].annotations
    assert accepted.x==10.125 and corrected.x==31.5
    assert corrected.source=="model" and corrected.model_version=="varroa-v3" and corrected.confidence==.87
    assert human.source=="human" and human.reviewed
    stats=json.loads((root/"reviews"/(doc["image_id"]+".json")).read_text())
    assert [stats[k] for k in ("model_predictions","accepted_unchanged","corrected","rejected","manually_added","final_reviewed_mite_count")]==[3,1,1,1,1,3]
    assert json.loads((main.ROOT/"prediction_history"/(doc["image_id"]+".json")).read_text())["annotations"]==baseline["annotations"]


def test_canonical_roundtrip(client,tmp_path):
    doc,_=upload(client)
    doc=client.post(f"/api/images/{doc['image_id']}/perspective",json={"corners":[{"x":0,"y":0},{"x":119,"y":0},{"x":119,"y":79},{"x":0,"y":79}],"physical_width_mm":15,"physical_height_mm":10}).json()
    doc,baseline=predictions(client,doc,tmp_path)
    for a in doc["annotations"]:a["reviewed"]=True
    doc["review_complete"]=True
    response=client.put(f"/api/images/{doc['image_id']}/annotations",json=doc)
    assert response.status_code==200,response.text
    root=tmp_path/"reviewed";assert export(client,doc,root,"ground_truth").status_code==200
    _,docs=load_bundle(root,training=True)
    for actual,expected in zip(docs[0].annotations,baseline["annotations"]):
        assert actual.x==pytest.approx(expected["x"],abs=1e-9)
        assert actual.y==pytest.approx(expected["y"],abs=1e-9)
    stats=client.get(f"/api/images/{doc['image_id']}/review-statistics").json()
    assert stats["accepted_unchanged"]==3 and stats["corrected"]==0


def test_bad_import_and_immutable_provenance(client,tmp_path):
    doc,_=upload(client);doc,_=predictions(client,doc,tmp_path)
    doc["annotations"][0]["confidence"]=.99
    assert client.put(f"/api/images/{doc['image_id']}/annotations",json=doc).status_code==422
    assert client.post("/api/exchange/import",json={"directory":str(tmp_path/"predictions")}).status_code==422
    p=tmp_path/"predictions/manifest.json";m=json.loads(p.read_text());m["schema_version"]="2.0";p.write_text(json.dumps(m))
    r=client.post("/api/exchange/import",json={"directory":str(p.parent)})
    assert r.status_code==422 and "Unsupported schema_version" in r.text


def test_empty_image_requires_explicit_review(client,tmp_path):
    doc,_=upload(client)
    assert export(client,doc,tmp_path/"no","ground_truth").status_code==422
    doc["review_complete"]=True
    assert client.put(f"/api/images/{doc['image_id']}/annotations",json=doc).status_code==200
    assert export(client,doc,tmp_path/"yes","ground_truth").status_code==200
    assert load_bundle(tmp_path/"yes",training=True)[1][0].annotations==[]


def test_exif_original_bytes_and_coordinates(client,tmp_path):
    data=io.BytesIO()
    exif=Image.Exif();exif[274]=6
    Image.new("RGB",(120,80),"white").save(data,format="JPEG",exif=exif)
    doc=client.post("/api/images",files={"file":("rotated.jpg",data.getvalue(),"image/jpeg")}).json()
    assert (doc["original_width"],doc["original_height"])==(80,120)
    doc["annotations"]=[{"id":"rotated_point","x":70.125,"y":100.25,"source":"human","reviewed":True}]
    doc["review_complete"]=True
    assert client.put(f"/api/images/{doc['image_id']}/annotations",json=doc).status_code==200
    root=tmp_path/"oriented";assert export(client,doc,root,"ground_truth").status_code==200
    _,docs=load_bundle(root,training=True)
    assert (root/"images"/docs[0].image.filename).read_bytes()==data.getvalue()
    assert docs[0].annotations[0].x==70.125 and docs[0].annotations[0].y==100.25


def test_schema_examples():
    from pathlib import Path
    from backend.app.interchange import validate, ReviewFile
    root=Path(__file__).resolve().parents[2]/"examples/interchange"
    for name,kind in [("annotation",AnnotationFile),("prediction",AnnotationFile),("manifest",Manifest),("review",ReviewFile)]:
        validate(json.loads((root/(name+".json")).read_text()),kind)
