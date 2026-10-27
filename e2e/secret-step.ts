// A demo-path step that handles the deployed site's real password, and what its failure may say.
//
// Playwright writes a failed fill's value into the error's call log, and the JSON report (kept
// under docs/nightly) stores that error. An assertion that fails while the filled field is still
// on the page snapshots the field, value included, into the error context it writes. So on the
// deployed target a failure here first leaves the page (best effort), then throws only the fixed
// message given, with no cause: nothing of the original error is kept. Locally the original error
// is rethrown as it was (the local login is a fake one).

export type SecretStepOptions = {
  deployed: boolean;
  // The whole error on the deployed target: fixed text, never built from the failure.
  message: string;
  // Takes the page away from the filled field before the run records anything.
  leave: () => Promise<unknown>;
};

export async function secretStep<T>(options: SecretStepOptions, run: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (err) {
    if (!options.deployed) throw err;
    await options.leave().catch(() => undefined);
    // The original error is dropped on purpose: its message is what carries the value.
    throw new Error(options.message);
  }
  return result;
}
