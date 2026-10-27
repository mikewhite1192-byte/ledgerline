import type { DocumentMime } from "./types";

// The seam for cropping a cab photo down to the paper before it is read. Today it returns its
// input unchanged, and readDocument calls it only when flags.documentCrop is on (it is off). A
// later item replaces this body with a segmentation call and a crop; nothing else changes.

export type Prepared = { bytes: Uint8Array; mime: DocumentMime; cropped: false };

export async function prepareImage(bytes: Uint8Array, mime: DocumentMime): Promise<Prepared> {
  return { bytes, mime, cropped: false };
}
