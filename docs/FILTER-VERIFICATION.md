# Report filter verification — QuickBooks Online

**Status: UNVERIFIED.** The probe described below has been written but has
**not been run against any QuickBooks realm** (sandbox or production). No
result in this document has been observed. Nothing below the line marked
"Result" is a real measurement — do not treat it as one.

## Why this document exists

QuickBooks Online does not error when a report is called with a filter
parameter name it doesn't recognize. It silently ignores the parameter and
returns the full, unfiltered report — which looks exactly like a correctly
filtered one. If `class` should have been `classid` (or vice versa) on any
report this fork exposes, a caller asking for one division's P&L would
silently receive the whole company's figures labelled as that division. No
unit test can catch this, because the bug is in what Intuit's API accepts,
not in what this codebase sends.

`scripts/verify-report-filters.ts` is a differential probe: for each filter
parameter it fetches the report both with and without the filter and
compares totals. Identical totals mean the parameter was ignored.

It checks two filter families, on every report this fork adds that claims to
support them:

| Report                  | Filter param | Kind    |
|--------------------------|--------------|---------|
| ProfitAndLoss             | `class`      | class   |
| ProfitAndLossDetail       | `classid`    | class   |
| TransactionList           | `class`      | class   |
| ProfitAndLossDetail       | `account`    | account |
| TransactionList           | `account`    | account |

The `account` checks exist because Intuit already demonstrates the same
kind of inconsistency with `class` vs `classid` on the two P&L reports —
`account` could just as plausibly need to be `accountid` on one or both of
the reports above. This was flagged in review, added beyond the original
task brief, and has the same UNVERIFIED status as everything else here.

Before testing any filter, the probe also checks that every report endpoint
this fork introduces (`ProfitAndLossDetail`, `TransactionList`,
`AgedReceivableDetail`, `ClassSales`, `JournalReport`) actually resolves —
a filter result against a report name that 404s proves nothing.

## What must be run

This has to be run against a **sandbox** realm first, and then again against
**production** before anyone treats these numbers as trustworthy — a sandbox
pass does not by itself certify production, since realm data/config can
differ.

```bash
QBO_ACCESS_TOKEN='<short-lived access token, NOT the refresh token>' \
QBO_REALM_ID='<realm id>' \
QBO_ENV=sandbox \
  npx tsx scripts/verify-report-filters.ts
```

Get the access token from Intuit's OAuth playground, or from the gateway's
logs during a live call. Repeat with `QBO_ENV=production` and the production
realm/token once the sandbox run is clean.

Optional, to widen or narrow the date window the probe queries (default is
the current calendar year — pick a window with real transaction activity in
the realm you're testing, ideally spanning more than one class and more than
one active account, or the probe will report itself unable to verify rather
than a false pass):

```bash
PROBE_START=2026-01-01 PROBE_END=2026-12-31 \
QBO_ACCESS_TOKEN=... QBO_REALM_ID=... QBO_ENV=sandbox \
  npx tsx scripts/verify-report-filters.ts
```

## Reading the output

- **`RESOLVES ✅` / `BAD NAME ❌`** (endpoint check, runs first) — a `BAD
  NAME` on any endpoint stops the probe immediately (exit 1). Fix the path
  in `src/domains/reports.ts` and re-run; filter results against a
  non-existent report prove nothing.
- **`FILTERS ✅`** — the filtered and unfiltered totals differed, so the
  parameter had an effect. This is evidence the name is right, not
  absolute proof — see the zero-rows caveat below.
- **`IGNORED ❌`** — the filtered and unfiltered totals were identical. The
  wire parameter name for that report is wrong. Swap it (e.g. `class` ↔
  `classid`, or `account` ↔ `accountid`) in `src/domains/reports.ts`, update
  the corresponding expectation in `src/__tests__/reports.test.ts`, and
  re-run the probe from scratch (fixing one endpoint doesn't validate the
  others).
- **`SKIPPED ⚠️`** — the realm didn't have enough data to prove that specific
  filter one way or the other (fewer than 2 classes, or fewer than 2
  accounts showing activity in the probe window on that report). This is
  **not a pass** — re-run with a wider date range or a realm with more
  transaction variety until it resolves to `FILTERS` or `IGNORED`.
- A `FILTERS ✅` report that comes back with **zero rows** is also
  suspicious — it can mean the parameter is accepted but the value shape is
  wrong (an ID expected where a name was sent, or a single value where a
  comma-separated list was expected). Don't wave this through: sanity-check
  the row count printed by the probe against what you expect from the
  realm's data.

Overall exit code:

- `0` — every filter that could be tested narrowed its report. PASS.
- `1` — a bad endpoint name, or at least one filter proven `IGNORED`. Fix
  before trusting any report this touches.
- `3` — nothing was proven wrong, but at least one filter was `SKIPPED` for
  lack of data. INCOMPLETE — treat as not-yet-verified, not as a pass.

## Result

**No run has been recorded.** This section is a placeholder for the
verbatim output of an actual invocation. When the probe is run, paste here:

- The date of the run.
- The realm type (sandbox / production) and which realm.
- The QBO minor version in force (pinned to `75` as of this writing — see
  `src/utils/client.ts`).
- The exact command used (including `PROBE_START` / `PROBE_END` if
  overridden).
- The full, verbatim console output of the probe (all `RESOLVES`/`BAD NAME`,
  `FILTERS`/`IGNORED`/`SKIPPED` lines and the final `RESULT:` line).
- The exit code.
- If the run ended in `IGNORED` and was fixed: what changed in
  `src/domains/reports.ts` and `src/__tests__/reports.test.ts`, and the
  output of the re-run that confirmed the fix.

```
<paste sandbox run output here — date, realm, minor version, full console output, exit code>
```

```
<paste production run output here — date, realm, minor version, full console output, exit code>
```

Until both blocks above contain a real, dated run, treat every filter this
fork claims to support as **unverified**, regardless of what the code
comments or unit tests say.
