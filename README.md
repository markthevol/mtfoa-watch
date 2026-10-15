# MTFOA watchdog

Every 5 minutes this checks mtfoa.org and the backend's public health addresses (five checks: pages, portal page, backend and database, members/roster/meetings, sign-in service) from GitHub (outside Cloudflare, and not the Mac) and
sends a phone message through ntfy when something goes down, every 30 minutes while it stays down, and when it comes back.
A probe has to fail twice, 20 seconds apart, before it counts. Nothing here touches member data: it reads the same addresses anyone can open.

- `watch.mjs`: the checks and the decision logic. `node watch.mjs` (set `DRY_RUN=1` to see what it would send).
- State: what it saw last (up or down, since when) is kept in GitHub's private Actions cache, never in this public repository.
- Logs: say how many checks answered, never which failed or why; the details go only to the phone.
- The payments health address is deliberately NOT checked here (it asks Stripe each time); Better Stack watches it.
- Secret: `NTFY_TOPIC` (the private ntfy topic; see `~/.config/mtfoa/ntfy-topic` on the Mac).
- Public repository on purpose: GitHub gives unlimited Actions minutes to public repositories, and there is nothing private in it.
