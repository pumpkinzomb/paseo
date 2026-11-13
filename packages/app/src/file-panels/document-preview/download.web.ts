export const canDownloadPreview = true;
export async function downloadPreviewFile(url: string, fileName: string): Promise<void> {
  if (!url.startsWith("blob:")) throw Error("Expected local preview bytes");
  const response = await fetch(url);
  if (!response.ok) throw Error("Preview bytes unavailable");
  const downloadUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = fileName;
  link.rel = "noopener";
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // The file panel may close while the browser's save prompt is still using these bytes.
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
  }
}
