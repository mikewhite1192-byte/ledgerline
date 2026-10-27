// The sample documents and their answer key. DOC-VISION's evaluation imports SAMPLE_DOCS and
// sampleDocFor from here; nothing here reads a file, renders or calls a model.
export {
  MANIFEST,
  PHOTO_SAMPLE_SENTENCE,
  PDF_FOOTER,
  SAMPLE_DOCS,
  SYNTHETIC_VENDORS,
  isPdf,
  isPhoto,
  sampleDocFor,
} from "./manifest";
export type {
  BolDoc,
  DocKind,
  DocRef,
  Manifest,
  PdfDoc,
  PhotoDoc,
  RateConDoc,
  ReceiptExpect,
  SampleDoc,
} from "./manifest";
