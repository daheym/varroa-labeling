export type Point = { x: number; y: number };
export type Annotation = Point & {
  id: string;
  className: "varroa";
  source: "human" | "model";
  confidence?: number | null;
  reviewed: boolean;
  model_version?: string | null;
  bbox?: {x: number; y: number; width: number; height: number} | null;
};
export type Doc = {
  schema_version: "1.0";
  review_complete: boolean;
  image_id: string;
  filename: string;
  original_width: number;
  original_height: number;
  coordinate_space: "original" | "canonical";
  perspective: null | { width: number; height: number; homography: number[][];
    file: string; source_points?: number[][]; source_corners?: number[][];
    physical_width_mm?: number; physical_height_mm?: number; pixels_per_mm?: number;
    quality_warning?: string | null; board_profile?: string | null };

  dataset_version: string;
  model_version: string | null;
  annotations: Annotation[];
  rejected_predictions: Annotation[];
  effort: Record<string, number>;
};

export type ModelOption = {
  id: string;
  label: string;
  model_version: string;
};

export type ModelRegistry = {
  models: ModelOption[];
  status: string;
};

export type TrainingStatus = {
  state: "idle" | "running" | "succeeded" | "failed" | "unavailable";
  message: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  pid?: number;
  log_tail?: string;
};

export type PredictionStatus = {
  state: "idle" | "running" | "succeeded" | "failed";
  message: string;
  request_id?: string;
  started_at?: string;
  finished_at?: string;
  error_status?: number;
};

// Mirror schemas/varroa-annotation-v1.schema.json. Runtime validation is server-side.
export type ExchangeAnnotation = Omit<Annotation, "className" | "confidence" | "model_version"> & {
  class: "varroa"; confidence: number | null; model_version: string | null;
};
export type ExchangeDocument = {
  schema_version: "1.0";
  image: {id: string; filename: string; width: number; height: number};
  perspective: Record<string, unknown> | null;
  annotations: ExchangeAnnotation[];
};
export type ExchangeManifest = {
  schema_version: "1.0"; dataset_version: string; created_at: string;
  purpose: "ground_truth" | "predictions" | "unreviewed";
  reviewed_image_ids: string[];
  images: {id: string; filename: string; annotation_file: string}[];
};
