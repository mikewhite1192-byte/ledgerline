import { STAFF_ONLY_BODY, STAFF_ONLY_TITLE } from "./staff-only";

// What a demo visitor (the judge role) sees in place of a staff-only control, such as an upload:
// the staff-only line, and no control that would call the server (which refuses a judge anyway).
export function StaffOnlyLine() {
  return (
    <p className="rounded-md bg-secondary px-3 py-2 text-small text-foreground">
      <span className="font-semibold">{STAFF_ONLY_TITLE}.</span> {STAFF_ONLY_BODY}
    </p>
  );
}
