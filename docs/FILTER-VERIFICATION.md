# Report filter verification — QuickBooks Online

**Status: UNVERIFIED.** The checks described below have been written but have
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

## The two front ends

The checks live once, in `src/__tests__/report-filter-checks.ts`, and are run
two ways:

| | What | When |
|---|---|---|
| **Durable** | `src/__tests__/sandbox.integration.test.ts` | Automatically, by `.github/workflows/integration.yml`, on every push to `main` or `gateway` — the moment the `QBO_SANDBOX_*` secrets exist |
| **Manual** | `scripts/verify-report-filters.ts` | By hand, against any realm — notably **production**, which CI never touches |

The integration test is the one that matters: it makes verification a property
of the branch rather than a ritual someone has to remember. The script remains
the escape hatch for realms CI has no credentials for.

> **A fork does not inherit the upstream repo's secrets.** Someone must set
> `QBO_SANDBOX_CLIENT_ID`, `QBO_SANDBOX_CLIENT_SECRET`,
> `QBO_SANDBOX_REFRESH_TOKEN` and `QBO_SANDBOX_REALM_ID` on
> **`shaank0/qbo-mcp`** directly. Until then the integration job runs, detects
> no credentials, emits a `::notice::` and skips — which is green, and is
> **not** evidence of anything.

## What is checked

### 0. Endpoint names resolve

Every report endpoint this fork introduces is fetched before any filter is
probed. A filter result against a report name that 404s proves nothing.
Endpoint spellings are verify-then-ship: Wyre maps `GeneralLedger` while
`node-quickbooks` exposes `GeneralLedgerDetail`, so QuickBooks demonstrably has
reports with variant names.

Checked: `ProfitAndLoss`, `ProfitAndLossDetail`, `TransactionList`,
`AgedReceivableDetail`, `ClassSales`, `JournalReport`.

### 1–3. Each filter narrows its report

For each filter parameter, the report is fetched **both** with and without the
filter and the totals compared. Identical totals mean the parameter was
ignored.

| Report                  | Wire parameter | Kind    |
|--------------------------|----------------|---------|
| `ProfitAndLoss`           | `class`        | class   |
| `ProfitAndLossDetail`     | `classid`      | class   |
| `TransactionList`         | `class`        | class   |
| `ProfitAndLossDetail`     | `account`      | account |
| `TransactionList`         | `account`      | account |

Note the caller-facing tool argument is `class` on **both** P&L reports; only
the wire name differs. The `account` checks exist because Intuit already
demonstrates that kind of inconsistency with `class` vs `classid` — `account`
could just as plausibly need to be `accountid` on one or both reports.

### 4. The parts sum to the whole

**Step 3 only proves the parameter did *something*. Step 4 proves it did the
*right* thing.** A parameter that QuickBooks accepts but interprets differently
than intended — wrong ID space, first-match-only, name-vs-ID coercion — changes
the report (passing step 3) while returning the wrong class's data. Only
summing every class and comparing against the unfiltered total exposes that.

So for each class-filtered report with a grand total, every **leaf** class's
filtered total is summed and reconciled against the unfiltered total, to the
cent.

- **Leaf classes only.** QuickBooks' class filter on a *parent* class includes
  its sub-classes, so summing parents and children together double-counts every
  sub-class and manufactures a failure out of correct code.
- **`TransactionList` is exempt** — it is a bare listing with no grand-total
  row, so there is nothing to sum. Step 3 is its only differential evidence.
- **Two benign causes of a mismatch**, which must be ruled out before changing
  any code: transactions with **no class** land in QuickBooks' "Not Specified"
  bucket and belong to no class's total (check the Not Specified column of a
  P&L run with `summarize_column_by=Classes`); and transactions classed
  directly to a **parent** class are counted by no leaf class's filter. If
  neither explains the delta, the wire parameter name is wrong.

### 5. `summarize_column_by` values are real

The same silent-ignore trap one level down. The P&L schema advertises
`Departments` and `Customers`, both taken from Intuit's own MCP server and
neither confirmed against Intuit's documentation. If a value is not recognised,
QuickBooks ignores the parameter and returns a single-column Total report that
reads as entirely legitimate.

Each value is fetched and its **column signature** compared against a
`summarize_column_by=Total` baseline. Identical columns mean the value did
nothing. The realm must contain at least one record of the corresponding entity
(`Class` / `Department` / `Customer`) for the check to mean anything.

Until a run records these as passing, the tool schema itself says so: the
`summarize_column_by` description marks `Departments` and `Customers` as
unverified and points here.

### A note on account candidates

`ProfitAndLossDetail` has **no account column** — it groups *by* account in
section headers, and the row's own `Split` column is the *contra* account. An
earlier version of this probe looked for a column literally titled `"Account"`
on both reports, which meant the `ProfitAndLossDetail` account check reported
`SKIPPED` on every realm regardless of data, while advising the operator to
widen the date range — advice that could never work.

The checks now take account candidates from the `"Account"` column when the
report has one (`TransactionList`) and from the **section path** otherwise
(`ProfitAndLossDetail`), which the flattener preserves as `section` on every
row. Candidates are resolved against `SELECT * FROM Account` by `Name` and then
`FullyQualifiedName`; a section segment that is a pure grouping header
("Income") simply fails to resolve and the next candidate is tried.

## Running the manual probe

Run against a **sandbox** realm first, and then against **production** before
anyone treats these numbers as trustworthy — a sandbox pass does not by itself
certify production, since realm data and configuration differ.

```bash
QBO_ACCESS_TOKEN='<short-lived access token, NOT the refresh token>' \
QBO_REALM_ID='<realm id>' \
QBO_ENV=sandbox \
  npx tsx scripts/verify-report-filters.ts
```

Get the access token from Intuit's OAuth playground, or from the gateway's logs
during a live call. Repeat with `QBO_ENV=production` and the production
realm/token once the sandbox run is clean.

Optional:

```bash
PROBE_START=2026-01-01 PROBE_END=2026-12-31 \  # default: current calendar year
PROBE_TOLERANCE=0.01 \                          # reconciliation tolerance, in currency units
QBO_ACCESS_TOKEN=... QBO_REALM_ID=... QBO_ENV=sandbox \
  npx tsx scripts/verify-report-filters.ts
```

Pick a window with real transaction activity, spanning more than one class and
more than one active account, or the probe will report itself unable to verify
rather than issue a false pass.

## Reading the output

- **`RESOLVES ✅` / `BAD NAME ❌`** — a `BAD NAME` on any endpoint stops the
  probe immediately (exit 1). Fix the path in `src/domains/reports.ts` and
  re-run.
- **`FILTERS ✅`** — filtered and unfiltered totals differed, so the parameter
  had an effect. Evidence the name is right, not absolute proof — see the
  zero-rows caveat below, and note this is only step 3.
- **`IGNORED ❌`** — filtered and unfiltered totals were identical. The wire
  parameter name for that report is wrong. Swap it (`class` ↔ `classid`,
  `account` ↔ `accountid`) in `src/domains/reports.ts`, update the
  corresponding expectation in `src/__tests__/reports.test.ts`, and re-run from
  scratch (fixing one endpoint doesn't validate the others).
- **`RECONCILES ✅` / `RECONCILE ❌`** — step 4. A `RECONCILE ❌` prints the
  delta and the two benign causes to rule out first.
- **`NO TOTAL ⚠️`** — that report has no grand-total row to reconcile
  (`TransactionList`). Expected, and not a failure by itself.
- **`SPLITS ✅` / `IGNORED ❌`** on a `summarize_column_by` line — whether that
  enum value actually changed the report's columns.
- **`SKIPPED ⚠️`** — the realm didn't have enough data to prove that check
  either way. This is **not a pass** — re-run with a wider date range or a realm
  with more variety until it resolves.
- A `FILTERS ✅` report that comes back with **zero rows** is also suspicious —
  the parameter may be accepted but the value shape wrong (an ID expected where
  a name was sent, or a single value where a comma-separated list was
  expected). Sanity-check the row count against what the realm should contain.

Overall exit code:

- `0` — every check that could be run passed. PASS.
- `1` — a bad endpoint name, a filter proven `IGNORED`, or a failed
  reconciliation. Fix before trusting any report this touches.
- `3` — nothing proven wrong, but at least one check was `SKIPPED` for lack of
  data. INCOMPLETE — treat as not-yet-verified, not as a pass.

The integration test makes the same distinctions, except that a realm without
enough data **fails** rather than skipping. That is deliberate: a silent skip
would reproduce the exact failure mode this document exists to prevent —
something that looks verified but never was. A red integration run means "this
realm cannot prove the filters are real", which is fixed by seeding the sandbox
company, not by editing code.

## Result

**No run has been recorded.** This section is a placeholder for the verbatim
output of an actual invocation. When the checks are run, paste here:

- The date of the run.
- The realm type (sandbox / production) and which realm.
- Whether it was the CI integration run or the manual script.
- The QBO minor version in force (pinned to `75` as of this writing — see
  `src/utils/client.ts`).
- The exact command used (including `PROBE_START` / `PROBE_END` if overridden).
- The full, verbatim output (all `RESOLVES`/`BAD NAME`,
  `FILTERS`/`IGNORED`/`SKIPPED`, `RECONCILES`/`RECONCILE` and `SPLITS` lines,
  and the final `RESULT:` line).
- The exit code.
- If the run ended in a failure that was then fixed: what changed in
  `src/domains/reports.ts` and `src/__tests__/reports.test.ts`, and the output
  of the re-run that confirmed the fix.

```
<paste sandbox run output here — date, realm, minor version, full console output, exit code>
```

```
<paste production run output here — date, realm, minor version, full console output, exit code>
```

Until both blocks above contain a real, dated run, treat every filter this fork
claims to support as **unverified**, regardless of what the code comments or
unit tests say. The gateway's operator guide (`docs/QBO_BACKEND.md` in the
MCP_Gateway repo) gates tool approval and role grants on this file recording a
pass.
