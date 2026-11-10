export function parseDataImageUrl(url: string): { mimeType: string; data: string } | undefined {
  const commaIndex = url.indexOf(",");
  if (!url.startsWith("data:") || commaIndex === -1) return undefined;
  const header = url.slice(5, commaIndex);
  const segments = header.split(";");
  const mimeType = segments.shift();
  const data = url.slice(commaIndex + 1);
  if (!mimeType?.toLowerCase().startsWith("image/") || segments.at(-1)?.toLowerCase() !== "base64" || !data) {
    return undefined;
  }
  return { mimeType, data };
}
