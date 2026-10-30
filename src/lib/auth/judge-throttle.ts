// The demo sign-in's own brake, in this server process, before its password sign-in
// (src/app/sign-in/try-demo-action.ts). Every visitor signs in as the one judge login, before any
// visit limit is read, so a click loop could otherwise reach the user pool's sign-in throttle and
// lock real sign-ins out. At most JUDGE_SIGN_INS_PER_MINUTE in any rolling minute; past it the
// click is refused with no Cognito call. Per process, so approximate across instances. Time is
// passed in, so the tests set it; production passes nothing and reads the clock.

export const JUDGE_SIGN_INS_PER_MINUTE = 20;
const WINDOW_MS = 60_000;

export type SignInBrake = { take(now: number): boolean };

// A brake that lets `limit` sign-ins through in any `windowMs`. It keeps at most `limit` instants.
// A time that is not a finite number is refused (fail closed).
export function signInBrake(limit = JUDGE_SIGN_INS_PER_MINUTE, windowMs = WINDOW_MS): SignInBrake {
  const taken: number[] = [];
  return {
    take(now) {
      if (!Number.isFinite(now)) return false;
      while (taken.length > 0 && taken[0] <= now - windowMs) taken.shift();
      if (taken.length >= limit) return false;
      taken.push(now);
      return true;
    },
  };
}

let brake = signInBrake();

// True when this sign-in may go on to Cognito; false is a refusal.
export function takeJudgeSignIn(now: number = Date.now()): boolean {
  return brake.take(now);
}

// A fresh brake (tests).
export function resetJudgeSignIns(): void {
  brake = signInBrake();
}
