export const canDownloadPreview = false;
export async function downloadPreviewFile(_url: string, _fileName: string): Promise<void> {
  throw Error("Preview download is not supported on this platform");
}
