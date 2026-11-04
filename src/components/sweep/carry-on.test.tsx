// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerRoleProvider } from "@/components/app/viewer-role";
import type { Role } from "@/lib/roles";
import { ADVANCE_LIMIT, CarryOn } from "./carry-on";

// Home's carry-on: it advances the newest run while a read says it is running, refreshes Home
// once when a read says it is not, stops at the advance limit, and never asks for a judge. The
// advance route, the run's read and the router are fakes.

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.refresh.mockReset();
});

const RUN = "8b1f0c2e-5d4a-4e3b-9c7d-1a2b3c4d5e6f";
const ADVANCE = `/api/sweeps/${RUN}/advance`;
const READ = `/api/sweeps/${RUN}`;

// statuses: what each read answers in turn, the last one repeated; a number is a failed read and
// null a run with no status.
function serve(statuses: (string | number | null)[]) {
  let reads = 0;
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    const s = statuses[Math.min(reads, statuses.length - 1)];
    reads += 1;
    if (typeof s === "number") return { ok: false, status: s, json: async () => ({}) } as unknown as Response;
    const run = s === null ? { id: RUN } : { id: RUN, status: s };
    return { ok: true, status: 200, json: async () => ({ run }) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const posts = (f: ReturnType<typeof serve>) => f.mock.calls.filter((c) => c[1]?.method === "POST");

function mount(role: Role) {
  return render(
    <ViewerRoleProvider role={role}>
      <CarryOn runId={RUN} />
    </ViewerRoleProvider>,
  );
}

describe("CarryOn", () => {
  it("advances while the run is running, then refreshes Home once and stops", async () => {
    const fetchMock = serve(["running", "running", "done"]);
    const { container } = mount("admin");
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(posts(fetchMock)).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledWith(ADVANCE, { method: "POST" });
    expect(fetchMock).toHaveBeenCalledWith(READ, { cache: "no-store" });
    await new Promise((r) => setTimeout(r, 20));
    expect(posts(fetchMock)).toHaveLength(3);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // It shows nothing of its own.
    expect(container.innerHTML).toBe("");
  });

  it("carries on through a read that fails or does not say, as still running", async () => {
    const fetchMock = serve([500, null, "", "failed"]);
    mount("staff");
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(posts(fetchMock)).toHaveLength(4);
  });

  it(`stops at ${ADVANCE_LIMIT} advances while the run stays running, with no refresh`, async () => {
    const fetchMock = serve(["running"]);
    mount("admin");
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(ADVANCE_LIMIT), { timeout: 5_000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(posts(fetchMock)).toHaveLength(ADVANCE_LIMIT);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("never asks anything for a demo visitor's judge role", async () => {
    const fetchMock = serve(["running"]);
    mount("judge");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
