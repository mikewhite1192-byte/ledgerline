# LedgerLine working rules

These bind every session in this repo. The reasoning: AI review and CI are budgets, and the
review budget is shared with the owner's other projects.

## CodeRabbit

1. **One round per PR.** Marking a PR ready is the only review. Fix every finding in one commit,
   get a fresh read of the fix diff BEFORE the push, push once, reply on each thread saying what
   changed, comment `@coderabbitai resolve`, and merge once CI is green. Nobody requests another
   review, on any tier, and no automation does either. Only the owner can ask for another round,
   for that PR.
2. **Draft first, ready when the review can run.** Drafts are not reviewed. Push once, open a
   draft, and mark it ready one at a time, never as a batch.
3. **The pool is per developer, across every repo.** Limits follow the identity that opens the
   PR, so this repo and the owner's other projects drain one pool, and more seats do not add
   capacity. Reviews in the last 7 days set the rate: 0-39 = 8 an hour, 40-49 = 6, 50-59 = 4,
   60-69 = 2, 70 or more = 1. Before marking a PR ready, count across all repos with
   `gh search prs --author @me --created ">=YYYY-MM-DD" --limit 200` (7 days back; skip drafts and
   `[skip-cr]`). That counts PRs, not reviews, so treat it as an estimate. Under 50, go. At 50 or
   more, only a production fix, or a PR that other work is waiting on, may be marked ready; the
   rest stay in draft. When the pool is tight, production repos go first.
4. **Paid reviews only on the owner's say, for that PR.** At the limit a review pauses and shows
   the file count and maximum price. Wait for the slot the banner names ("Next included review
   available in N minutes"), then request that one review once; it is still the single round, not
   a second one. If it cannot wait, the owner decides. No session or automation authorizes a paid
   review on its own.
5. **"Review rate limited" is not a review.** That check passes while nothing was reviewed. Never
   merge on it.
6. **High-risk PRs get a second reader.** When marking ready a PR in a danger zone (rules engine,
   ledger, money, autopilot, agent tools and gateway, migrations and RLS, auth, infra), also
   request Copilot at Lite effort, never Max (effort is a repo and account setting, not a flag on
   the request):
   `gh api -X POST repos/OWNER/REPO/pulls/N/requested_reviewers -f 'reviewers[]=copilot-pull-request-reviewer[bot]'`.
   It uses no CodeRabbit slot, and its findings go in the same one fix commit. It adds to
   CodeRabbit and never replaces it.
7. **Low-risk PRs skip CodeRabbit.** A PR that touches only UI, copy, docs, tests or seed data
   takes `[skip-cr]` in its title and gets a Copilot review at Lite effort instead.
