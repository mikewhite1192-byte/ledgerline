// Runs once when the server starts. The money guard refuses to start the server with a live key,
// a production QuickBooks company or a raw secret in production; the log names the variable only.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertMoneyEnvSafe } = await import("./lib/money/guard");
  console.info(assertMoneyEnvSafe(process.env));
}
