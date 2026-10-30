import type { Role } from "../../src/lib/roles";

// The demo logins `npm run demo:users` keeps, and the password plan around them, apart from the
// AWS calls so the tests can pin it. Invented names on reserved .example domains: no real company,
// no real mailbox.

export const DEMO_SECRET_NAME = "payday-copilot/demo-logins";
// The demo visitor's login (the judge role) has a secret of its own: the app's server role will
// read this one to sign a visitor in, and must never be able to read the carriers' admin passwords
// in demo-logins.
export const JUDGE_SECRET_NAME = "payday-copilot/judge-login";

export const CARRIERS = [
  {
    slug: "blue-ridge",
    name: "Blue Ridge Freight Lines",
    timezone: "America/New_York",
    email: "ops@blueridge.example",
  },
  {
    slug: "prairie-wind",
    name: "Prairie Wind Transport",
    timezone: "America/Chicago",
    email: "ops@prairiewind.example",
  },
] as const;

export type Carrier = (typeof CARRIERS)[number];

// One login. `key` names its entry in demo-logins; the judge's secret holds that one login alone.
// Only a carrier's admin login creates the carrier; every other login joins the carrier its admin
// login names.
export type DemoLogin = {
  key: string;
  email: string;
  role: Role;
  carrier: Carrier;
  secret: "demo" | "judge";
};

export type DemoUserArgs = { resetPasswords: boolean; judge: boolean; clerk: boolean };

const FLAGS: Record<string, keyof DemoUserArgs> = {
  "--reset-passwords": "resetPasswords",
  "--judge": "judge",
  "--clerk": "clerk",
};

// The script's own flags, nothing else: a typo must not run the default set by surprise.
export function parseDemoUserArgs(argv: readonly string[]): DemoUserArgs {
  const args: DemoUserArgs = { resetPasswords: false, judge: false, clerk: false };
  for (const arg of argv) {
    const flag = FLAGS[arg];
    if (!flag) throw new Error(`unknown option ${arg}: use --reset-passwords, --judge or --clerk`);
    args[flag] = true;
  }
  return args;
}

// The carriers' admin logins always, then the office clerk (staff) and the demo visitor (judge)
// on Blue Ridge when asked for.
export function demoLogins(args: DemoUserArgs): DemoLogin[] {
  const blueRidge = CARRIERS[0];
  const logins: DemoLogin[] = CARRIERS.map((carrier) => ({
    key: carrier.slug,
    email: carrier.email,
    role: "admin",
    carrier,
    secret: "demo",
  }));
  if (args.clerk) {
    logins.push({
      key: "blue-ridge-clerk",
      email: "clerk@blueridge.example",
      role: "staff",
      carrier: blueRidge,
      secret: "demo",
    });
  }
  if (args.judge) {
    logins.push({
      key: "judge",
      email: "judge@blueridge.example",
      role: "judge",
      carrier: blueRidge,
      secret: "judge",
    });
  }
  return logins;
}

export type Password = { email: string; password: string };
// The secrets as read: undefined when a secret does not exist yet, else its parsed JSON, unchecked.
export type StoredSecrets = { demo?: unknown; judge?: unknown };

export type PasswordPlan = {
  // The secrets' next contents, and whether each must be written before any password is set.
  demo: Record<string, Password>;
  judge?: Password;
  writeDemo: boolean;
  writeJudge: boolean;
  // Every login's password, applied on every run so a login always matches its secret.
  apply: Password[];
};

function usable(saved: unknown, email: string): saved is Password {
  if (typeof saved !== "object" || saved === null) return false;
  const s = saved as Record<string, unknown>;
  return s.email === email && typeof s.password === "string" && s.password.length > 0;
}

// A login keeps the password its secret holds; --reset-passwords, or a password nobody recorded
// (no entry, another email, an empty value), gets a new one. Other keys in demo-logins are kept.
export function planPasswords(
  logins: readonly DemoLogin[],
  stored: StoredSecrets,
  resetPasswords: boolean,
  generate: () => string,
): PasswordPlan {
  // demo-logins may hold logins this run does not name, so a shape it cannot read stops the run
  // rather than being overwritten. The judge's secret holds its one login and is simply replaced.
  const demo = stored.demo;
  if (demo !== undefined && (typeof demo !== "object" || demo === null || Array.isArray(demo))) {
    throw new Error(`${DEMO_SECRET_NAME} is not a JSON object; fix it by hand`);
  }
  const savedDemo = (demo ?? {}) as Record<string, unknown>;
  const plan: PasswordPlan = { demo: {}, writeDemo: false, writeJudge: false, apply: [] };
  for (const [key, value] of Object.entries(savedDemo)) plan.demo[key] = value as Password;
  for (const login of logins) {
    const saved = login.secret === "judge" ? stored.judge : savedDemo[login.key];
    let entry: Password;
    if (!resetPasswords && usable(saved, login.email)) {
      entry = { email: login.email, password: saved.password };
    } else {
      entry = { email: login.email, password: generate() };
      if (login.secret === "judge") plan.writeJudge = true;
      else plan.writeDemo = true;
    }
    if (login.secret === "judge") plan.judge = entry;
    else plan.demo[login.key] = entry;
    plan.apply.push(entry);
  }
  return plan;
}
