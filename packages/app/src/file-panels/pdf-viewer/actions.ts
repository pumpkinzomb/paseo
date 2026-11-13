import { createContext } from "react";
export interface PdfPrintAction {
  run(): void;
  busy: boolean;
  ready: boolean;
}
export const PdfPrintActionContext = createContext<
  ((action: PdfPrintAction | null) => void) | null
>(null);
