import { createHash } from "node:crypto";

// Where the browser keeps the agent's questions this person closed with the x: asks: and an opaque
// value from the tenant and the sign-in, built on the server so the page never carries the raw
// tenant id or sign-in id. Server code only (it sends nothing to the browser but the result).
export function dismissKey(tenantId: string, sub: string): string {
  return `asks:${createHash("sha256").update(`${tenantId}:${sub}`).digest("hex").slice(0, 32)}`;
}
