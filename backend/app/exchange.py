"""File-only exchange adapter for the local annotation application."""
import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image, ImageOps
from .interchange import AnnotationFile, Manifest, ReviewFile, validate, dump, load_bundle
from .models import Annotation
from .perspective import transform_points

def original_annotations(doc):
    result = []
    for a in doc.annotations:
        x,y = a.x,a.y
        if doc.coordinate_space == "canonical":
            x,y = transform_points([(x,y)], doc.perspective["inverse_homography"])[0]
        result.append({"id": a.id, "class": "varroa", "x": x, "y": y,
            "bbox": a.bbox, "source": a.source, "confidence": a.confidence,
            "model_version": a.model_version or (doc.model_version if a.source == "model" else None), "reviewed": a.reviewed})
    return result

def annotation_document(doc, filename):
    return {"schema_version": "1.0", "image": {"id": doc.image_id, "filename": filename,
        "width": doc.original_width, "height": doc.original_height},
        "perspective": doc.perspective, "annotations": original_annotations(doc)}

def statistics(root, doc):
    baseline = root / "prediction_history" / (doc.image_id + ".json")
    predictions = json.loads(baseline.read_text("utf-8"))["annotations"] if baseline.exists() else []
    before = root / "prediction_history" / (doc.image_id + ".before.json")
    existing_humans = {a["id"] for a in json.loads(before.read_text("utf-8"))["annotations"] if a["source"] == "human"} if before.exists() else set()
    current = {a["id"]: a for a in original_annotations(doc)}
    accepted = corrected = rejected = 0
    for a in predictions:
        b = current.get(a["id"])
        if b is None:
            rejected += 1
        elif b["reviewed"]:
            if abs(a["x"]-b["x"]) < 1e-7 and abs(a["y"]-b["y"]) < 1e-7 and a.get("bbox") == b.get("bbox"):
                accepted += 1
            else:
                corrected += 1
    return {"schema_version":"1.0", "image_id":doc.image_id, "model_predictions":len(predictions),
        "accepted_unchanged":accepted, "corrected":corrected, "rejected":rejected,
        "manually_added":sum(a.source == "human" and a.reviewed and a.id not in existing_humans for a in doc.annotations),
        "final_reviewed_mite_count":sum(a.reviewed for a in doc.annotations)}

def export_bundle(root, documents, output, dataset_version, purpose="ground_truth"):
    output = Path(output).resolve()
    root = Path(root).resolve()
    if output.exists() or output.is_relative_to(root) or root.is_relative_to(output):
        raise ValueError("Choose a new export directory outside application data")
    if not documents:
        raise ValueError("No images selected")
    prepared = []
    annotation_ids = set()
    for doc in documents:
        if purpose == "ground_truth" and (not doc.review_complete or any(not a.reviewed for a in doc.annotations)):
            raise ValueError("Finish image review before ground-truth export (including empty images)")
        source = root / "images" / (doc.image_id + ".original")
        with Image.open(source) as im:
            if im.format not in ("JPEG", "PNG"):
                raise ValueError("Only original JPEG/PNG images are supported")
            if ImageOps.exif_transpose(im).size != (doc.original_width, doc.original_height):
                raise ValueError("Original image dimensions differ from document")
            suffix = ".jpg" if im.format == "JPEG" else ".png"
        filename = doc.image_id + suffix
        payload = annotation_document(doc, filename)
        validate(payload, AnnotationFile)
        for a in doc.annotations:
            if a.id in annotation_ids:
                raise ValueError("duplicate annotation IDs across images")
            annotation_ids.add(a.id)
        prepared.append((doc,source,filename,payload))
    manifest = {"schema_version":"1.0", "dataset_version":dataset_version,
        "created_at":datetime.now(timezone.utc).isoformat(), "purpose":purpose,
        "reviewed_image_ids":[d.image_id for d in documents if d.review_complete],
        "images":[{"id":d.image_id,"filename":f,"annotation_file":d.image_id+".json"} for d,_,f,_ in prepared]}
    validate(manifest, Manifest)
    output.mkdir(parents=True)
    (output/"images").mkdir()
    for doc,source,filename,payload in prepared:
        shutil.copyfile(source, output/"images"/filename)
        dump(output/"annotations"/(doc.image_id+".json"), payload, AnnotationFile)
        if doc.review_complete:
            dump(output/"reviews"/(doc.image_id+".json"), statistics(root,doc), ReviewFile)
    dump(output/"manifest.json", manifest, Manifest)
    load_bundle(output, training=purpose == "ground_truth")
    return manifest

def import_predictions(root, directory, read, write, validate_points):
    manifest, docs = load_bundle(directory, images=False)
    if manifest.purpose != "predictions":
        raise ValueError("Expected a predictions manifest")
    prepared = []
    for incoming in docs:
        doc = read(incoming.image.id)
        if (doc.original_width,doc.original_height) != (incoming.image.width,incoming.image.height):
            raise ValueError("Prediction dimensions differ from original image")
        with Image.open(root/"images"/(doc.image_id+".original")) as im:
            expected = doc.image_id + (".jpg" if im.format == "JPEG" else ".png")
        if incoming.image.filename != expected:
            raise ValueError("Prediction filename differs from exported image")
        if doc.model_version is not None:
            raise ValueError("Image already has a prediction batch; preserve its review before resetting annotations")
        before = doc.model_dump_json(indent=2)
        for a in incoming.annotations:
            x,y = a.x,a.y
            if doc.coordinate_space == "canonical":
                x,y = transform_points([(x,y)],doc.perspective["homography"])[0]
            doc.annotations.append(Annotation(id=a.id,x=x,y=y,source="model",confidence=a.confidence,
                model_version=a.model_version, bbox=a.bbox.model_dump() if a.bbox else None,reviewed=False))
        doc.review_complete = False
        doc.model_version = next((a.model_version for a in incoming.annotations), "empty-prediction-batch")
        validate_points(doc)
        prepared.append((doc,incoming,before))
    # Validate every member before mutating any document.
    for doc,incoming,before in prepared:
        dump(root/"prediction_history"/(doc.image_id+".json"),incoming.model_dump(by_alias=True),AnnotationFile)
        (root/"prediction_history"/(doc.image_id+".before.json")).write_text(before,encoding="utf-8")
        write(doc)
    return [doc for doc,_,_ in prepared]
