// Runs when the server prepares (at start under `next start`). The money guard refuses a live key,
// a production QuickBooks company or a raw secret in production; the log names the variable only.
// A refusal does not stop the process: Next keeps the rejected start-up, so every request answers
// 500 for as long as the process runs. Nothing is served and nothing moves (fail closed).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertMoneyEnvSafe } = await import("./lib/money/guard");
  console.info(assertMoneyEnvSafe(process.env));
}
