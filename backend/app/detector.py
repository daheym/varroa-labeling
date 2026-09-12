from typing import Protocol
from pathlib import Path
from .models import Candidates


class Detector(Protocol):
    """Adapter boundary: outputs must use original, EXIF-oriented image pixels."""
    def predict(self, image_path: Path, model_version: str) -> Candidates: ...
    def train(self, dataset_path: Path, dataset_version: str) -> str: ...


class UnconfiguredDetector:
    def predict(self, image_path: Path, model_version: str) -> Candidates:
        raise NotImplementedError('No detector configured. Import candidate JSON for review.')

    def train(self, dataset_path: Path, dataset_version: str) -> str:
        raise NotImplementedError('Training is not implemented.')
