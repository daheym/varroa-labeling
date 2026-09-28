"""Adapter to inference and training in the sibling varroa-training repository.

The labeling environment stays lightweight. Work is delegated to the training
repository's own environment and launchers; inference calls the same
``predict_image`` pipeline used by offline evaluation and interchange.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from .models import Annotation, Candidates


class DetectorError(RuntimeError):
    """Base class for errors that should be shown as actionable API responses."""


class DetectorUnavailable(DetectorError):
    pass


class UnknownModel(DetectorError):
    pass


class PredictionFailed(DetectorError):
    pass


class TrainingAlreadyRunning(DetectorError):
    pass


class Detector(Protocol):
    def models(self) -> list[dict]: ...

    def predict(self, image_path: Path, *, perspective: dict, model_id: str) -> Candidates: ...

    def start_training(self, data_root: Path) -> dict: ...

    def training_status(self) -> dict: ...


@dataclass(frozen=True)
class TrainedModel:
    id: str
    label: str
    model_version: str
    checkpoint: Path
    config: Path

    def public(self) -> dict[str, str]:
        return {"id": self.id, "label": self.label, "model_version": self.model_version}


CONTRACT_CONFIG_KEYS = (
    "pixels_per_mm",
    "tile_size",
    "overlap",
    "imgsz",
    "min_source_scale_ratio",
    "quality_policy",
    "allow_legacy_original",
)


class TrainingRepoDetector:
    """Find compatible completed runs and invoke their matching inference CLI."""

    def __init__(
        self,
        training_root: Path,
        python: Path,
        normalization: dict,
        timeout_seconds: int = 600,
    ):
        self.training_root = Path(training_root).resolve()
        self.python = Path(python).resolve()
        self.normalization = normalization
        self.timeout_seconds = timeout_seconds
        self._training_lock = threading.Lock()
        self._training_process: subprocess.Popen | None = None
        self._training = {
            "state": "idle",
            "message": "No training run has been started from the labeling tool.",
        }
        self._training_log = self.training_root / "runs" / ".labeling-training.log"

    @property
    def status(self) -> str:
        if not self.training_root.is_dir() or not (self.training_root / "runs").is_dir():
            return "training_repo_missing"
        if not self.python.is_file():
            return "training_python_missing"
        return "ready"

    def models(self) -> list[dict]:
        return [model.public() for model in self._models()]

    def _training_command(self, data_root: Path) -> list[str]:
        script = self.training_root / "scripts" / "train-production.ps1"
        if not script.is_file():
            raise DetectorUnavailable(f"Production training launcher not found: {script}")
        shell = shutil.which("powershell.exe") or shutil.which("pwsh")
        if not shell:
            raise DetectorUnavailable("PowerShell is required to run the production training launcher")
        base_config = self.training_root / "configs" / "labeling.json"
        try:
            config = json.loads(base_config.read_text("utf-8"))
            config.update({
                "images": str((data_root / "images").resolve()),
                "annotations": str((data_root / "annotations").resolve()),
            })
            launch_config = self.training_root / "runs" / ".labeling-live-config.json"
            temporary = launch_config.with_suffix(".tmp")
            temporary.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
            temporary.replace(launch_config)
        except (OSError, json.JSONDecodeError) as exc:
            raise DetectorUnavailable(f"Could not create the live training configuration: {exc}") from exc
        return [
            shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script),
            "-BaseConfig", str(launch_config),
        ]

    def training_status(self) -> dict:
        with self._training_lock:
            status = dict(self._training)
        if status["state"] not in {"idle", "unavailable"} and self._training_log.is_file():
            try:
                status["log_tail"] = self._training_log.read_text(
                    encoding="utf-8", errors="replace"
                )[-8000:]
            except OSError:
                pass
        return status

    def start_training(self, data_root: Path) -> dict:
        if self.status != "ready":
            raise DetectorUnavailable(
                "The sibling training repository or its Python environment is unavailable"
            )
        with self._training_lock:
            if self._training_process is not None and self._training_process.poll() is None:
                raise TrainingAlreadyRunning("A production training run is already in progress")
            command = self._training_command(Path(data_root))
            self._training_log.parent.mkdir(parents=True, exist_ok=True)
            try:
                log = self._training_log.open("w", encoding="utf-8")
                creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                process = subprocess.Popen(
                    command,
                    cwd=self.training_root,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    text=True,
                    creationflags=creationflags,
                )
            except OSError as exc:
                if "log" in locals():
                    log.close()
                raise DetectorUnavailable(f"Could not start production training: {exc}") from exc
            log.close()
            self._training_process = process
            self._training = {
                "state": "running",
                "message": "Validating data, preparing tiles, and training the production model.",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "pid": process.pid,
            }
            status = dict(self._training)

        threading.Thread(
            target=self._finish_training,
            args=(process,),
            name="varroa-production-training",
            daemon=True,
        ).start()
        return status

    def _finish_training(self, process: subprocess.Popen) -> None:
        exit_code = process.wait()
        with self._training_lock:
            if process is not self._training_process:
                return
            self._training = {
                **self._training,
                "state": "succeeded" if exit_code == 0 else "failed",
                "message": (
                    "Production training completed. The new model is ready for predictions."
                    if exit_code == 0
                    else "Production training failed. Open the log details for the error."
                ),
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "exit_code": exit_code,
            }

    def _checkpoint_for(self, metadata_path: Path, metadata: dict) -> Path | None:
        recorded = metadata.get("checkpoint")
        if not isinstance(recorded, str) or not recorded:
            return None
        name = Path(recorded).name
        candidates = []
        recorded_path = Path(recorded)
        if recorded_path.is_absolute():
            candidates.append(recorded_path)
        candidates.extend((
            metadata_path.parent / "yolo" / "weights" / name,
            metadata_path.parent / "weights" / name,
        ))
        for candidate in candidates:
            try:
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(self.training_root)
            except (OSError, ValueError):
                continue
            if resolved.is_file():
                return resolved
        return None

    def _compatible(self, metadata: dict, checkpoint: Path) -> bool:
        config = metadata.get("config")
        if not isinstance(config, dict) or any(key not in config for key in CONTRACT_CONFIG_KEYS):
            return False
        sidecar_path = checkpoint.with_suffix(".preprocessing.json")
        try:
            sidecar = json.loads(sidecar_path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        expected = {
            "normalization_version": 1,
            "pixel_convention": "board_edges",
            **{key: config[key] for key in CONTRACT_CONFIG_KEYS},
        }
        if sidecar != expected:
            return False
        if sidecar.get("normalization_version") != 1 or sidecar.get("pixel_convention") != "board_edges":
            return False
        # The annotator's perspective transform is created with these settings.
        # A model at another physical scale cannot consume its canonical raster.
        return all(
            sidecar.get(key) == self.normalization.get(key)
            for key in ("pixels_per_mm", "min_source_scale_ratio", "quality_policy")
        )

    def _models(self) -> list[TrainedModel]:
        if not self.training_root.is_dir() or not self.python.is_file():
            return []
        found: dict[str, TrainedModel] = {}
        finished_at: dict[str, str] = {}
        for metadata_path in (self.training_root / "runs").rglob("metadata.json"):
            try:
                metadata = json.loads(metadata_path.read_text("utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if metadata.get("status") != "complete":
                continue
            checkpoint = self._checkpoint_for(metadata_path, metadata)
            config_path = metadata_path.parent / "config.yaml"
            if not checkpoint or not config_path.is_file() or not self._compatible(metadata, checkpoint):
                continue
            digest = metadata.get("checkpoint_sha256")
            if isinstance(digest, str) and digest:
                actual = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
                if actual != digest:
                    continue
            model_id = checkpoint.relative_to(self.training_root).as_posix()
            version = f"{model_id}@{digest[:12]}" if isinstance(digest, str) and digest else model_id
            found[model_id] = TrainedModel(
                id=model_id,
                label=model_id,
                model_version=version,
                checkpoint=checkpoint,
                config=config_path.resolve(),
            )
            finished_at[model_id] = str(metadata.get("finished_at", ""))
        return sorted(found.values(), key=lambda item: (finished_at[item.id], item.id), reverse=True)

    def predict(self, image_path: Path, *, perspective: dict, model_id: str) -> Candidates:
        if not self.python.is_file():
            raise DetectorUnavailable(f"Training Python environment not found: {self.python}")
        model = next((item for item in self._models() if item.id == model_id), None)
        if model is None:
            raise UnknownModel("Selected model is no longer available or is incompatible with this annotator")
        if not image_path.is_file():
            raise PredictionFailed("The selected image file is missing")
        perspective_file = perspective.get("file")
        if not perspective_file:
            raise PredictionFailed("Generate physical perspective correction before requesting predictions")

        with tempfile.TemporaryDirectory(prefix="varroa-predict-") as temp_dir:
            temp = Path(temp_dir)
            metadata_path = temp / "perspective.json"
            output = temp / "prediction"
            metadata_path.write_text(json.dumps({"perspective": perspective}), encoding="utf-8")
            command = [
                str(self.python), "-m", "src.cli",
                "--config", str(model.config),
                "infer",
                "--weights", str(model.checkpoint),
                "--image", str(image_path.resolve()),
                "--perspective", str(metadata_path),
                "--output", str(output),
            ]
            try:
                completed = subprocess.run(
                    command,
                    cwd=self.training_root,
                    capture_output=True,
                    text=True,
                    timeout=self.timeout_seconds,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise PredictionFailed("Prediction timed out; try a smaller image or increase VARROA_PREDICT_TIMEOUT") from exc
            except OSError as exc:
                raise DetectorUnavailable(f"Could not start the training environment: {exc}") from exc
            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout or "Training inference failed").strip()
                raise PredictionFailed(detail[-3000:])
            try:
                result = json.loads(output.with_suffix(".json").read_text("utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise PredictionFailed("Training inference did not produce a valid prediction JSON file") from exc

        if result.get("coordinate_space") != "canonical":
            raise PredictionFailed("Training inference returned coordinates outside the normalized image")
        annotations = []
        normalized_perspective = result.get("perspective") or {}
        original_width = normalized_perspective.get("original_width")
        original_height = normalized_perspective.get("original_height")
        for detection in result.get("detections", []):
            x1, y1, x2, y2 = map(float, detection["box"])
            bbox = None
            polygon = detection.get("original_polygon")
            if polygon and original_width and original_height:
                original_x1 = max(0.0, min(float(point[0]) for point in polygon))
                original_y1 = max(0.0, min(float(point[1]) for point in polygon))
                original_x2 = min(float(original_width), max(float(point[0]) for point in polygon))
                original_y2 = min(float(original_height), max(float(point[1]) for point in polygon))
                if original_x2 > original_x1 and original_y2 > original_y1:
                    # In the labeling document, annotation points are canonical
                    # while optional detection boxes retain original-image pixels.
                    bbox = {
                        "x": original_x1,
                        "y": original_y1,
                        "width": original_x2 - original_x1,
                        "height": original_y2 - original_y1,
                    }
            annotations.append(Annotation(
                id="pred_" + uuid.uuid4().hex,
                className="varroa",
                x=(x1 + x2) / 2,
                y=(y1 + y2) / 2,
                bbox=bbox,
                source="model",
                confidence=float(detection["confidence"]),
                model_version=model.model_version,
                reviewed=False,
            ))
        return Candidates(
            model_version=model.model_version,
            coordinate_space="canonical",
            perspective_file=perspective_file,
            annotations=annotations,
        )


class UnconfiguredDetector:
    """Used when the sibling training repository is not configured or present."""

    status = "unconfigured"

    def models(self) -> list[dict]:
        return []

    def predict(self, image_path: Path, *, perspective: dict, model_id: str) -> Candidates:
        raise DetectorUnavailable("Configure VARROA_TRAINING_ROOT and VARROA_TRAINING_PYTHON to enable inference")

    def start_training(self, data_root: Path) -> dict:
        raise DetectorUnavailable(
            "Configure VARROA_TRAINING_ROOT and VARROA_TRAINING_PYTHON to enable training"
        )

    def training_status(self) -> dict:
        return {
            "state": "unavailable",
            "message": "The sibling training repository is not configured.",
        }


def configured_detector(normalization: dict) -> TrainingRepoDetector:
    default_root = Path(__file__).resolve().parents[3] / "varroa-training"
    root = Path(os.environ.get("VARROA_TRAINING_ROOT", default_root))
    if os.name == "nt":
        default_python = root / ".venv" / "Scripts" / "python.exe"
    else:
        default_python = root / ".venv" / "bin" / "python"
    python = Path(os.environ.get("VARROA_TRAINING_PYTHON", default_python))
    timeout = int(os.environ.get("VARROA_PREDICT_TIMEOUT", "600"))
    return TrainingRepoDetector(root, python, normalization, timeout_seconds=timeout)
