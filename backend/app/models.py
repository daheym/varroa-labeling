from typing import Literal
from pydantic import BaseModel, Field, ConfigDict


class Point(BaseModel):
    model_config = ConfigDict(extra='forbid')
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)


class Annotation(Point):
    id: str
    className: Literal['varroa'] = 'varroa'
    source: Literal['human', 'model']
    confidence: float | None = Field(default=None, ge=0, le=1)
    reviewed: bool = False
    model_version: str | None = None
    bbox: dict | None = None


class Effort(BaseModel):
    manual_adds: int = Field(default=0, ge=0)
    accepts: int = Field(default=0, ge=0)
    deletes: int = Field(default=0, ge=0)
    moves: int = Field(default=0, ge=0)
    undo: int = Field(default=0, ge=0)
    redo: int = Field(default=0, ge=0)
    active_seconds: float = Field(default=0, ge=0)


class Document(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: Literal['1.0'] = '1.0'
    review_complete: bool = False
    image_id: str
    filename: str
    original_width: int
    original_height: int
    coordinate_space: Literal['original', 'canonical'] = 'original'
    perspective: dict | None = None
    dataset_version: str = '1'
    model_version: str | None = None
    annotations: list[Annotation] = []
    rejected_predictions: list[Annotation] = []
    effort: Effort = Field(default_factory=Effort)


class Candidates(BaseModel):
    model_config = ConfigDict(extra='forbid')
    model_version: str = Field(min_length=1)
    coordinate_space: Literal['canonical']
    perspective_file: str
    annotations: list[Annotation]


class Corners(BaseModel):
    corners: list[Point] = Field(min_length=4, max_length=4)
    board_profile: str | None = None
    physical_width_mm: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    physical_height_mm: float | None = Field(default=None, gt=0, allow_inf_nan=False)


class ResetConfirmation(BaseModel):
    confirmation: Literal['RESET ALL']
