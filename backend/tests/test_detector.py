import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

from backend.app import detector as detector_module
from backend.app.detector import TrainingRepoDetector


def make_run(root: Path, name='run-a'):
    run = root / 'runs' / name
    checkpoint = run / 'yolo' / 'weights' / 'best.pt'
    checkpoint.parent.mkdir(parents=True)
    checkpoint.write_bytes(b'test weights')
    config = {
        'pixels_per_mm': 16.0,
        'tile_size': 640,
        'overlap': 128,
        'imgsz': 640,
        'min_source_scale_ratio': 0.75,
        'quality_policy': 'warn',
        'allow_legacy_original': False,
    }
    contract = {
        'normalization_version': 1,
        'pixel_convention': 'board_edges',
        **config,
    }
    (run / 'config.yaml').write_text('mode: holdout\n', encoding='utf-8')
    metadata = {
        'status': 'complete',
        'finished_at': '2026-09-13T09:00:00+00:00',
        'checkpoint': str(checkpoint),
        'checkpoint_sha256': hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        'config': config,
    }
    (run / 'metadata.json').write_text(json.dumps(metadata), encoding='utf-8')
    checkpoint.with_suffix('.preprocessing.json').write_text(json.dumps(contract), encoding='utf-8')
    return run, checkpoint, config


def test_registry_lists_only_complete_scale_compatible_runs(tmp_path):
    training = tmp_path / 'training'
    good_run, checkpoint, _ = make_run(training)
    make_run(training, 'old-run')
    (training / 'runs' / 'old-run' / 'yolo' / 'weights' / 'best.preprocessing.json').unlink()
    _, wrong_scale, _ = make_run(training, 'wrong-scale')
    sidecar = json.loads(wrong_scale.with_suffix('.preprocessing.json').read_text())
    sidecar['pixels_per_mm'] = 8
    wrong_scale.with_suffix('.preprocessing.json').write_text(json.dumps(sidecar), encoding='utf-8')

    detector = TrainingRepoDetector(
        training,
        Path(sys.executable),
        {'pixels_per_mm': 16.0, 'min_source_scale_ratio': 0.75, 'quality_policy': 'warn'},
    )
    models = detector.models()
    assert len(models) == 1
    assert models[0]['id'] == checkpoint.relative_to(training).as_posix()
    assert models[0]['label'] == models[0]['id']
    assert models[0]['model_version'].endswith(hashlib.sha256(checkpoint.read_bytes()).hexdigest()[:12])
    assert good_run.exists()


def test_predict_calls_training_cli_and_maps_canonical_detection(tmp_path, monkeypatch):
    training = tmp_path / 'training'
    _, checkpoint, _ = make_run(training)
    detector = TrainingRepoDetector(
        training,
        Path(sys.executable),
        {'pixels_per_mm': 16.0, 'min_source_scale_ratio': 0.75, 'quality_policy': 'warn'},
    )
    image = tmp_path / 'image.png'
    image.write_bytes(b'image')
    observed = {}

    def fake_run(command, **kwargs):
        observed['command'] = command
        observed['cwd'] = kwargs['cwd']
        output = Path(command[command.index('--output') + 1])
        prediction = {
            'coordinate_space': 'canonical',
            'perspective': {'original_width': 120, 'original_height': 80},
            'detections': [{
                'box': [10, 20, 14, 25],
                'confidence': 0.83,
                'original_polygon': [[1, 2], [5, 2], [5, 8], [1, 8]],
            }],
        }
        output.with_suffix('.json').write_text(json.dumps(prediction), encoding='utf-8')
        return SimpleNamespace(returncode=0, stdout='Mite count: 1', stderr='')

    monkeypatch.setattr(detector_module.subprocess, 'run', fake_run)
    result = detector.predict(
        image,
        perspective={'file': 'corrected.png', 'source_points': []},
        model_id=checkpoint.relative_to(training).as_posix(),
    )
    assert observed['cwd'] == training.resolve()
    assert observed['command'][1:3] == ['-m', 'src.cli']
    assert str(checkpoint) == observed['command'][observed['command'].index('--weights') + 1]
    assert result.coordinate_space == 'canonical'
    assert result.annotations[0].x == 12
    assert result.annotations[0].y == 22.5
    assert result.annotations[0].bbox == {'x': 1, 'y': 2, 'width': 4, 'height': 6}
    assert result.annotations[0].confidence == 0.83


def test_predict_reports_training_cli_failure(tmp_path, monkeypatch):
    training = tmp_path / 'training'
    _, checkpoint, _ = make_run(training)
    detector = TrainingRepoDetector(
        training,
        Path(sys.executable),
        {'pixels_per_mm': 16.0, 'min_source_scale_ratio': 0.75, 'quality_policy': 'warn'},
    )
    image = tmp_path / 'image.png'
    image.write_bytes(b'image')
    monkeypatch.setattr(detector_module.subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(
        returncode=1, stdout='', stderr='contract mismatch'))
    try:
        detector.predict(image, perspective={'file': 'corrected.png'}, model_id=checkpoint.relative_to(training).as_posix())
    except detector_module.PredictionFailed as exc:
        assert 'contract mismatch' in str(exc)
    else:
        raise AssertionError('Expected the training CLI error to be surfaced')
