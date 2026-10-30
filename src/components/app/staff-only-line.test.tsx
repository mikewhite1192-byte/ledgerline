// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Uploader } from "@/app/voice-notes/uploader";
import { ClipUploader } from "@/components/clips/redactor";
import { UploadForm } from "@/components/documents/upload-form";
import type { Role } from "@/lib/roles";
import { STAFF_ONLY_BODY } from "./staff-only";
import { ViewerRoleProvider } from "./viewer-role";

// The three upload controls: a demo visitor (the judge role) sees the staff-only line and no file
// picker or button, and nothing calls the server; staff see the control as before.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const LIMITS = { maxWavBytes: 1_000_000, maxOriginalBytes: 700_000, maxDurationMs: 60_000 };
const CONTROLS: [string, () => ReactElement][] = [
  ["documents", () => <UploadForm maxBytes={5_000_000} maxPdfPages={5} />],
  [
    "voice notes",
    () => <Uploader drivers={[{ id: "d1", code: "D-001", name: "Pat Lee" }]} disabled={false} agentOn limits={LIMITS} />,
  ],
  ["dock clips", () => <ClipUploader loads={[{ id: "l1", loadNumber: "L-1", label: "L-1" }]} onDone={() => undefined} />],
];

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (role: Role, control: () => ReactElement) =>
  render(<ViewerRoleProvider role={role}>{control()}</ViewerRoleProvider>);

describe("upload controls by role", () => {
  it.each(CONTROLS)("%s: a judge sees the staff-only line instead of the control", (_name, control) => {
    const { container } = show("judge", control);
    expect(screen.getByText(STAFF_ONLY_BODY, { exact: false })).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(CONTROLS)("%s: staff see the control", (_name, control) => {
    const { container } = show("staff", control);
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
    expect(screen.queryByText(STAFF_ONLY_BODY, { exact: false })).toBeNull();
  });
});
