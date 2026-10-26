// The local and CI database URL: the admin login of a Postgres on this machine. Anything that
// drops or migrates through it refuses a remote host, so a stray DATABASE_URL cannot reach a
// shared database. A unix socket (?host=/path) counts as local.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function localDatabaseUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_URL is not a postgresql:// URL");
  }
  const socket = url.searchParams.get("host");
  const local = socket ? socket.startsWith("/") : LOCAL_HOSTS.has(url.hostname);
  if (!local) throw new Error("DATABASE_URL must point at a database on this machine");
  return url;
}

// The same server and login, another database.
export function withDatabase(url: URL, database: string): URL {
  const copy = new URL(url);
  copy.pathname = `/${database}`;
  return copy;
}
