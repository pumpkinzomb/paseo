export const DEFAULT_THUMBNAIL_WIDTH = 110;
export const MIN_THUMBNAIL_WIDTH = 72;
export const MAX_THUMBNAIL_WIDTH = 240;
export interface PdfViewerPreferences {
  width: number;
  collapsed: boolean;
}
export function thumbnailWidth(value: number): number {
  return Math.round(Math.max(MIN_THUMBNAIL_WIDTH, Math.min(MAX_THUMBNAIL_WIDTH, value)));
}
export function parsePdfPreferences(value: unknown): PdfViewerPreferences | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("width" in value) ||
    !("collapsed" in value) ||
    typeof value.width !== "number" ||
    !Number.isFinite(value.width) ||
    typeof value.collapsed !== "boolean"
  )
    return null;
  return { width: thumbnailWidth(value.width), collapsed: value.collapsed };
}
export const DEFAULT_PDF_PREFERENCES: PdfViewerPreferences = {
  width: DEFAULT_THUMBNAIL_WIDTH,
  collapsed: false,
};
export function effectiveThumbnailWidth(
  preferences: PdfViewerPreferences,
  containerWidth: number,
): number {
  if (preferences.collapsed || containerWidth < 360) return 0;
  return Math.min(
    thumbnailWidth(preferences.width),
    Math.max(MIN_THUMBNAIL_WIDTH, Math.floor(containerWidth * 0.35)),
  );
}
export interface PdfViewerLabels {
  loading: string;
  failed: string;
  toggle: string;
  resize: string;
  previous: string;
  next: string;
  page: string;
  zoomOut: string;
  zoomIn: string;
  fitWidth: string;
  openOriginal: string;
  password: string;
  printPreparing: string;
  printFailed: string;
  printTooLarge: string;
}
export interface PdfViewerLoadMessage {
  type: "pdf-load";
  bytes: ArrayBuffer;
  preferences: PdfViewerPreferences;
  labels: PdfViewerLabels;
  dark: boolean;
}
