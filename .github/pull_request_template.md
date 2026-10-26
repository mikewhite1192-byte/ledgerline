Second read: <head sha>

## Why

<Who asked, when, and what is missing or wrong today. One short paragraph. Quote the ask. Name
the brief's done-means line this serves, if any.>

Design: summarized below (D1-Dn approved <date>).

## What changes

<Per component: the behavior, the guards, what it never touches. Bullets.>

**Switch:** `<flag or config key>`: <off | dark | live at cap 1>, start date `<date>`.

## Proof

- Probes: <P1 read-only result; P2 write probe on throwaway records, cleaned up>.
- Tests: <N new checks in which suites>; full suite green; DB tests on a fresh database.
- Dry run on real data: <summary of a print-only / preview run, if the change supports one>.
- Second read (before the first push): <N findings by severity, all taken in one commit,
  each listed in one line>.

## Known interplay (not changed here)

<Other features this touches at the edges, and why that is safe or accepted.>

## Deploy and release

- Environment(s): <staging, then production>. Migration first: <file | none>.
- Rollback: <command or flag>.
- First run to read after deploy: <what the log or page should show>.
- Release: <who flips what, at what cap>. OPEN PROOF: <first real use to see>.
- CI minutes: <no new workflow, job or trigger | estimate: N billed minutes per push / per merge>.
