import type { Queryable } from "../db";
import type { DocumentFact } from "../rules-engine";

// The documents known for loads, as the invoice review reads them. The uploaded documents table
// (migration 0013) exists, but the review does not read it yet, so nothing is known: every load
// reads as having no documents, and no rate confirmation amount is ever compared. Wiring it in is
// a follow-up through this one function; the review rules already take the facts. Until then the
// review's words call a delivery document unconfirmed, never "none on file" (labels.ts).
export const DOCUMENTS_AVAILABLE = false;

export async function readDocumentFacts(q: Queryable, loadIds: readonly string[]): Promise<DocumentFact[]> {
  // Nothing is read yet; the arguments are the seam's contract.
  void q;
  void loadIds;
  return [];
}
