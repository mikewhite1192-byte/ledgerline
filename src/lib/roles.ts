// The roles a membership can hold (memberships_role_check, migration 0043). A judge is a demo
// visitor: it reads everything a staff member reads, asks the agent and proposes, and never
// approves, pays, posts, sends or changes a setting. Plain values only, so the shared components
// (and the public /design page) can name a role without importing auth code.
export const ROLES = ["admin", "staff", "judge"] as const;
export type Role = (typeof ROLES)[number];
export type StaffRole = Exclude<Role, "judge">;

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isJudge(role: Role): role is "judge" {
  return role === "judge";
}
