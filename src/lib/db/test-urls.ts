// Database tests only. DATABASE_URL is the admin login of a fresh, migrated local or CI
// database. The app connects as payday_app with no password, which trust auth accepts there
// (and nowhere else).
export function adminUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set: run npm run test:db:fresh");
  return url;
}

export function appUrl(): string {
  const url = new URL(adminUrl());
  url.username = "payday_app";
  url.password = "";
  return url.toString();
}

export function adminUser(): string {
  const name = decodeURIComponent(new URL(adminUrl()).username);
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("admin user name is not a plain identifier");
  return name;
}
