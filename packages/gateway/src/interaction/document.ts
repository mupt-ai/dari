const PDF_DATA_URL_PREFIX = "data:application/pdf;base64,";

/** The base64 payload of a PDF data URL, or undefined for anything else. */
export function parsePdfDataUrl(url: string): string | undefined {
  if (!url.startsWith(PDF_DATA_URL_PREFIX)) return undefined;
  const data = url.slice(PDF_DATA_URL_PREFIX.length);
  return data.length > 0 ? data : undefined;
}
