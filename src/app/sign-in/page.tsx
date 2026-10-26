import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { signInAction } from "./actions";

const fieldStyle = { display: "grid", gap: 4 } as const;
const inputStyle = { padding: "8px 10px", font: "inherit" } as const;

// Logins are created only by the demo script: no sign-up link, no password reset.
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  if (await getSession()) redirect("/");
  const { error } = await searchParams;
  const message =
    error === "invalid"
      ? "Email or password is wrong"
      : error === "unavailable"
        ? "Sign-in is unavailable right now"
        : null;

  return (
    <main style={{ maxWidth: 400, margin: "64px auto", padding: "0 16px" }}>
      <h1>LedgerLine</h1>
      <p style={{ marginTop: 12 }}>Sign in to your carrier.</p>
      {message ? (
        <p role="alert" style={{ marginTop: 12, color: "#b42318" }}>
          {message}
        </p>
      ) : null}
      <form action={signInAction} style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <label style={fieldStyle}>
          Email
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            style={inputStyle}
          />
        </label>
        <label style={fieldStyle}>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            style={inputStyle}
          />
        </label>
        <button type="submit" style={inputStyle}>
          Sign in
        </button>
      </form>
    </main>
  );
}
