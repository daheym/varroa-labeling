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
  coordinate_space: "original";
  perspective: null | { width: number; height: number; homography: number[][] };
  dataset_version: string;
  model_version: string | null;
  annotations: Annotation[];
  rejected_predictions: Annotation[];
  effort: Record<string, number>;
};
