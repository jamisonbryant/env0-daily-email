# Scheduled run instructions

These instructions are for the scheduled routine that builds and sends the daily env0 status email. The routine prompt supplies the **recipient**. It may also give a time zone, tracked branch or title; those are passed as environment variables for this run only. Nothing from the routine prompt is ever written to the repository.

## Steps

1. **Install only if needed.** If `node_modules` is missing **and** `mjml` is not on `PATH`, run `npm ci --omit=dev`. The globally installed `env0` and `mjml` CLIs are the normal path.
2. **Build the report.** Run:

   ```sh
   REPORT_TIMEZONE="<time zone from the routine prompt, if given>" node src/main.mjs
   ```

   Also set `REPORT_TRACKED_BRANCH` or `REPORT_TITLE` only if the routine prompt gives them. Record the exit code and the one line on stderr.
3. **On exit code 0**, send one email with the Gmail connector's `send_message` tool:
   - `to`: the recipient from the routine prompt
   - `subject`: the `subject` field of `out/summary.json`, exactly
   - `htmlBody`: the contents of `out/email.html`, unmodified
   - `body`: the contents of `out/email.txt` (the plain-text alternative)

   If `warnings` in `out/summary.json` is not empty, the email footer already lists them. Do not add commentary, greetings or summaries to the email.
4. **On any non-zero exit code**, send one short plain-text email (`body` only) to the same recipient:
   - `subject`: `<REPORT_TITLE>: report failed` (the default title is `env0 daily status`)
   - `body`, four lines:

     ```
     The env0 daily status report could not be built.
     Exit code: <code> (<meaning>)
     Reason: <the stderr line>
     Time: <current time in the report time zone, with zone name>
     ```

     Meanings: `2` env0 authentication failure, `3` data incomplete, `1` other error.

   Never skip the email silently, and never send a partial or stale report instead.

5. Confirm `send_message` returned a message ID, then stop.

## Rules

- Send **exactly one** email per run: either the report or the failure notice, never both, never retries that produce duplicates. If the send itself fails, report the failure in the session output; do not send again.
- **Never** commit, push, create branches, or modify any file tracked in this repository during a scheduled run. Writing to the untracked `out/` directory is expected.
- **Never** run mutating env0 commands (`deploy`, `destroy`, `approve`, `cancel`, `abort`, `archive`, `create`, `tag set`, `ttl`, `api-key create|revoke`, or similar). Only `node src/main.mjs` talks to env0.
- **Never** inspect, print or echo credentials, request headers or environment variables, including in the failure email.
- Do not modify the report output or retry the build with different settings to "fix" a failure. Report the failure as described above.
