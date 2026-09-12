export type Point = { x: number; y: number };
export type Annotation = Point & {
  id: string;
  className: "varroa";
  source: "human" | "model";
  confidence?: number;
  reviewed: boolean;
};
export type Doc = {
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
