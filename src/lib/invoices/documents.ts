import type { Queryable } from "../db";
import type { DocumentFact } from "../rules-engine";

// The documents known for loads, as the invoice review reads them. No document store is in this
// build yet (the document reading work lands separately, as PR #21), so nothing is known: every
// load reads as having no documents, and no rate confirmation amount is ever compared. When the
// store lands, this one function reads it; the review rules already take the facts.
export const DOCUMENTS_AVAILABLE = false;

export async function readDocumentFacts(q: Queryable, loadIds: readonly string[]): Promise<DocumentFact[]> {
  // Nothing to read until the store lands; the arguments are the seam's contract.
  void q;
  void loadIds;
  return [];
}
