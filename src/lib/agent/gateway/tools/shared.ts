import { z } from "zod";
import { TABLES } from "../../../rules-engine";
import type { AgentRole, GatewayRef } from "../types";
import { idField } from "../validate";

// Pieces several tools share: the role lists and the source reference schema.

export const OPERATOR: readonly AgentRole[] = ["operator"];
export const OPERATOR_AUDITOR: readonly AgentRole[] = ["operator", "auditor"];

// A record the model cites: a table from the engine's list and an id in it. The gateway checks
// each one exists in the caller's tenant before the tool runs.
export const sourceRefsField = () =>
  z.array(z.strictObject({ table: z.enum(TABLES), id: idField() })).max(8);

export function refsOf(list: readonly { table: GatewayRef["table"]; id: string }[]): GatewayRef[] {
  return list.map((r) => ({ table: r.table, id: r.id }));
}
