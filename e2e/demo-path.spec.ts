import { expect, test, type Locator, type Page } from "@playwright/test";
import { AUDIT_LINES, AUDITOR_OFF, checkAuditLine } from "./audit-line";
import { APP_URL, E2E_CARRIER, E2E_LOGIN, FAKE_HOST } from "./env.local-mode";
import { secretStep } from "./secret-step";

// The demo path, as a judge would walk it: sign in, ask the agent, open how it worked the answer
// out, get a proposal card (never approved here), read the models page, sign out.
//
// Local (npm run e2e): next dev on a fresh seeded database, every merged switch on through the
// local overrides, the models answered from the replay fixture by the fake host. After each model
// step the fake host's misses are read first, so a request with no recorded answer fails red with
// its fingerprint and what to re-record.
// Deployed (npm run e2e:deployed): the site at E2E_BASE_URL with the demo login from the
// environment. A step whose feature is not released there is marked skipped, never red, and so
// is the proposal step once the shared demo budget is spent (the auditor then gives no verdict).

const DEPLOYED = process.env.E2E_TARGET === "deployed";
// A local run answered from the fixture. A recording run (npm run e2e:record) takes the live
// model's own words, as a deployed run does.
const REPLAYED = !DEPLOYED && process.env.E2E_RECORD !== "1";
const FIRST_QUESTION = "Who has a problem on this week's paystub?";
// What the recorded first answer says (e2e/fixtures/model-replay.json): each driver with a
// problem and the amount carried forward for each. Live answers name the drivers with or without
// their codes, so the list holds the names alone. A re-record that words the answer differently
// updates this list.
const FIRST_ANSWER_SAYS = [
  "Kevin Yarborough",
  "$682.75",
  "Ellen Kowalski",
  "$483.71",
  "Wesley Delgado",
  "$146.61",
];
// The hero driver of the seed (the same ids every seed at the anchor), asked for a modest amount
// so the engine's limit allows it on any day of the demo week. The ask names a fixed date, never
// "today", so the replayed proposal's requestedOn is the date the question asks for on every run
// (the engine takes an ask dated today or earlier).
const ADVANCE_QUESTION = "Propose a $100.00 advance for Monique Vasquez (BR-D07), requested on 2026-10-27.";
// Local answers replay word for word as recorded on the fixture's recordedOn, whatever the run's date.
const TURN_TIMEOUT = 30_000;

type Features = { agent: boolean; auditor: boolean; reports: boolean };

function login(): { email: string; password: string } | null {
  if (!DEPLOYED) return E2E_LOGIN;
  const email = process.env.E2E_DEMO_EMAIL?.trim();
  const password = process.env.E2E_DEMO_PASSWORD;
  return process.env.E2E_BASE_URL && email && password ? { email, password } : null;
}

async function features(baseURL: string): Promise<Features> {
  const res = await fetch(new URL("/api/health", baseURL), { cache: "no-store" });
  expect(res.status, "the health check answers").toBe(200);
  const body = (await res.json()) as { features?: Partial<Features> };
  // Unknown is not released: a missing flag reads false.
  return {
    agent: body.features?.agent === true,
    auditor: body.features?.auditor === true,
    reports: body.features?.reports === true,
  };
}

// Local only: the fake host's requests with no recorded answer. Read before any assertion on what
// the model said, so a stale fixture names the request to re-record instead of a vague timeout.
async function expectNoReplayMisses(): Promise<void> {
  if (DEPLOYED) return;
  const res = await fetch(`${FAKE_HOST}/misses`, { cache: "no-store" });
  const body = (await res.json()) as { served: number; misses: { fingerprint: string; label: string }[] };
  const lines = body.misses.map((m) => `${m.fingerprint} ${m.label}`);
  expect(lines, "model requests with no recorded answer (re-record with npm run e2e:record)").toEqual([]);
  expect(body.served, "the replay host answered the model calls").toBeGreaterThan(0);
}

// The newest message in the conversation, once its turn has finished: the composer is no longer
// asking, and the answer carries its "How this was worked out" disclosure (shown only after the
// turn ends on the server).
async function finishedAnswer(page: Page, question: string): Promise<Locator> {
  const conversation = page.getByRole("list", { name: "Conversation" });
  await expect(conversation.getByText(question, { exact: true })).toBeVisible();
  const answer = conversation.locator(":scope > li").last();
  await expect(answer.getByRole("button", { name: "How this was worked out for this answer" })).toBeVisible({
    timeout: TURN_TIMEOUT,
  });
  await expect(page.getByRole("button", { name: /^Asking/ })).toHaveCount(0, { timeout: TURN_TIMEOUT });
  return answer;
}

async function answerText(answer: Locator): Promise<string> {
  const paragraphs = answer.locator(":scope > div > p.text-body");
  return (await paragraphs.allInnerTexts()).join(" ").trim();
}

test.describe.configure({ mode: "serial" });

test("the demo path: sign in, ask, trace, a proposal card, the models page, sign out", async ({ page, baseURL }) => {
  const creds = login();
  test.skip(
    creds === null,
    "skipped: the deployed run needs E2E_BASE_URL, E2E_DEMO_EMAIL and E2E_DEMO_PASSWORD in the environment",
  );
  if (!creds || !baseURL) throw new Error("no base URL");

  const on = await features(baseURL);
  if (!DEPLOYED) {
    // The local overrides took: the agent and the auditor run here even though main ships them off.
    expect(on, "every merged switch is on in local mode").toMatchObject({ agent: true, auditor: true });
    await test.step("warm up the dev server (local only)", async () => {
      // next dev compiles each page and route on its first request; doing it here keeps the
      // timed steps below about the app, not the compiler. Any answer is fine (405, 401, redirect).
      const id = "00000000-0000-4000-8000-000000000000";
      for (const path of [
        "/sign-in",
        "/",
        "/models",
        "/api/agent/turn",
        `/api/agent/turns/${id}`,
        `/api/agent/turns/${id}/trace`,
        `/api/proposals/${id}/audit`,
        "/api/auth/sign-out",
      ]) {
        await fetch(`${APP_URL}${path}`, { redirect: "manual", signal: AbortSignal.timeout(150_000) });
      }
    });
  }

  await test.step("1. sign in and land on the carrier's home", async () => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(creds.email);
    // The deployed project keeps no trace or screenshot, pass or fail (playwright.config.ts). From
    // the password fill until the home page shows, a deployed failure leaves the page and says
    // only a fixed message, so the password reaches neither the report nor the error context.
    const leave = () => page.goto("about:blank");
    await secretStep({ deployed: DEPLOYED, message: "password fill failed", leave }, () =>
      page.getByLabel("Password").fill(creds.password),
    );
    await secretStep({ deployed: DEPLOYED, message: "sign in did not reach the carrier's home", leave }, async () => {
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(new URL("/", baseURL).toString());
    });
    await expect(page.getByText(E2E_CARRIER.name).first()).toBeVisible();
  });

  let firstAnswer: Locator | null = null;

  await test.step("2. ask the agent a suggested question", async (step) => {
    step.skip(!on.agent, "skipped: not released (agent)");
    const chip = page.getByRole("list", { name: "Suggested questions" }).getByRole("button", { name: FIRST_QUESTION });
    if (DEPLOYED && (await chip.count()) === 0) {
      // A deployed thread may already hold turns, and the suggestions show only on an empty one.
      await page.getByLabel("Your question").fill(FIRST_QUESTION);
      await page.getByRole("button", { name: "Send" }).click();
    } else {
      await chip.click();
    }
    const answer = await finishedAnswer(page, FIRST_QUESTION);
    await expectNoReplayMisses();
    const said = await answerText(answer);
    expect(said, "the agent's answer has words").not.toBe("");
    // Replay only: the answer is the recorded one, word for word, so each name and figure it
    // recorded must reach the page. Read from the agent's words, not the report table below them.
    if (REPLAYED) {
      for (const text of FIRST_ANSWER_SAYS) expect(said, `the agent's answer says ${text}`).toContain(text);
    }
    firstAnswer = answer;
  });

  await test.step("3. the trace names Muse Spark and what the call cost", async (step) => {
    step.skip(!on.agent || firstAnswer === null, "skipped: not released (agent)");
    if (!firstAnswer) return;
    await firstAnswer.getByRole("button", { name: "How this was worked out for this answer" }).click();
    const steps = firstAnswer.getByRole("list", { name: "Steps, in order" });
    await expect(steps).toBeVisible();
    const sparkWithCost = steps
      .locator(":scope > li")
      .filter({ hasText: "Muse Spark" })
      .filter({ hasText: /\d+(\.\d)? cents|\$\d+\.\d{2}/ });
    await expect(sparkWithCost.first()).toBeVisible();
  });

  await test.step("4. a proposal card for the hero driver's advance, with the auditor's line", async (step) => {
    step.skip(!on.agent, "skipped: not released (agent)");
    await page.getByLabel("Your question").fill(ADVANCE_QUESTION);
    await page.getByRole("button", { name: "Send" }).click();
    const answer = await finishedAnswer(page, ADVANCE_QUESTION);
    const card = answer.getByRole("article").first();
    await expect(card).toBeVisible();
    // Replay only: the recorded answer set its checklist beside the first reads and ticked it to
    // the card, so the list shows with nothing left unfinished. A live model may word or skip it.
    if (REPLAYED) {
      const checklist = answer.getByRole("list", { name: "Checklist" });
      await expect(checklist).toBeVisible();
      await expect(checklist.getByText("Not finished")).toHaveCount(0);
    }
    // The auditor's line settles first (its check starts once the card shows), then the replay
    // misses are read, then what the card says.
    const auditLine = card.getByText(new RegExp(`^(${AUDIT_LINES.join("|")})$`));
    await expect(auditLine.first()).toBeVisible({ timeout: TURN_TIMEOUT });
    await expectNoReplayMisses();

    await expect(card.getByRole("heading", { level: 3 })).not.toBeEmpty();
    await expect(card).toContainText(/\$\d{1,3}(,\d{3})*\.\d{2}/);
    await expect(card.getByText("Why", { exact: true })).toBeVisible();
    await expect(card.locator("ul > li").first()).not.toBeEmpty();
    await expect(card.getByRole("button", { name: "Reject" })).toBeVisible();
    // A card the auditor blocked offers "Override and approve" instead of Approve.
    await expect(card.getByRole("button", { name: /^(Approve|Override and approve)/ })).toBeVisible();
    const shown = (await auditLine.first().innerText()).trim();
    const audit = checkAuditLine(shown, { auditorOn: on.auditor, deployed: DEPLOYED });
    const want = on.auditor ? "a second check result" : `"${AUDITOR_OFF}"`;
    expect(audit, `the auditor's line reads "${shown}", wanted ${want}`).not.toBe("wrong");
    // Deployed only: the shared demo budget is spent, so the auditor made no call and gave no
    // verdict. The card was checked above; the step is marked skipped, never passed.
    step.skip(audit === "budget_skip", "skipped: no auditor verdict (demo budget reached)");
    // Approve is not clicked in this version of the path.
  });

  await test.step("5. the models page shows the week and the demo budget", async () => {
    await page.goto("/models");
    await expect(page.getByRole("heading", { name: "This pay week" })).toBeVisible();
    // The calls just made are in this week's count.
    if (on.agent) await expect(page.getByText("Model calls", { exact: true })).toBeVisible();
    // The whole line, in dollars: with a budget set ("$0.42 of $2.00.") or without one.
    const spent = page.getByText(/^Spent so far this demo: /);
    await expect(spent).toBeVisible();
    await expect(spent).toHaveText(
      /^Spent so far this demo: \$\d{1,3}(,\d{3})*\.\d{2}( of \$\d{1,3}(,\d{3})*\.\d{2}|, with no budget set, so every call is refused)\.$/,
    );
  });

  await test.step("6. sign out returns to the sign-in page", async () => {
    // Sign out sits in the carrier menu in the top bar.
    await page.locator("summary").filter({ hasText: "carrier menu" }).click();
    await page.getByRole("button", { name: "Sign out" }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
