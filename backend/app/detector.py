from typing import Protocol
from pathlib import Path
from .models import Candidates


class Detector(Protocol):
    """Receive only the canonical raster. Return canonical points tied to perspective['file'].

    Validate model pixels/mm and input settings against perspective before inference.
    Never pass the original upload to this adapter.
    """
    def predict(self, canonical_image_path: Path, model_version: str, *, perspective: dict) -> Candidates: ...
    def train(self, dataset_path: Path, dataset_version: str) -> str: ...


class UnconfiguredDetector:
    def predict(self, canonical_image_path: Path, model_version: str, *, perspective: dict) -> Candidates:
        raise NotImplementedError('No detector configured. Import candidate JSON for review.')

    def train(self, dataset_path: Path, dataset_version: str) -> str:
        raise NotImplementedError('Training is not implemented.')
