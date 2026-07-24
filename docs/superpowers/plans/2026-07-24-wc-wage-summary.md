# WC Wage Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a faithful "Worker Comp Summary" section (Month → Check Date → Class Code pivot + per-check-date By-Class / By-Structure tables) to the farm-dash WC/TDI page, sourced from a new prod view, using base wages throughout.

**Architecture:** One new prod aggregate view `wc_summary_paycheck_v` (grain: check_date × wc_code × pay_structure, base-wage + overtime sums) shipped via a gated apply workflow in `aloha-data-migrations`. The farm-dash static page registers that view in `lib/data-source.js` and renders a new always-visible section in `wc-tdi/index.html` with vanilla JS, reusing the page's existing dark-theme CSS.

**Tech Stack:** PostgreSQL 17 view + GitHub Actions `psql` apply workflow (`aloha-data-migrations`); vanilla HTML/JS + Supabase-js CDN client (`farm-dash`). No test framework exists in either repo — verification is by workflow dry-run, REST probe, and browser render against prod (`?src=prod`).

## Global Constraints

- **Two repos.** DB work lives in `c:\Users\micha\Desktop\aloha-data-migrations`; UI work in `c:\Users\micha\Desktop\farm-dash`. Commit each repo separately.
- **Never `supabase db push`.** Apply schema only via a gated `apply-*.yml` workflow: dry-run (`apply=false`, `BEGIN…ROLLBACK`) first, then `apply=true`. The workflow file must be on `main` to be dispatchable; **actual prod dispatch is a human/operator action.**
- **Wage basis = base wages everywhere:** `base_wages = round(sum(gross_wage − overtime_pay − per_diem − auto_allowance), 2)`, each term `COALESCE(..., 0)`. `overtime = round(sum(overtime_pay), 2)`. Same formula as `wc_basis_paycheck_v`, so totals reconcile with the existing "Workers' Comp · monthly" table.
- **View filters (match sibling WC views):** `COALESCE(is_deleted, false) = false`, `payroll_processor <> 'HF'`, `org_id = 'hawaii_farming'`. `wc_code = COALESCE(NULLIF(TRIM(wc), ''), 'Unclassified')`. `GRANT SELECT TO anon, authenticated`.
- **Client scope:** drop rows whose class code is empty / `N/A` / `Unclassified`; limit to the 6 most recent calendar months present in the data; group by calendar month (no 6/22 renewal split).
- **Prod project:** `zdvpqygiqavwpxljpvqw`. Farm-dash reads via the anon publishable key already in `lib/data-source.js`.
- **Commit hooks:** if `git commit` fails with "cannot spawn .husky/pre-commit: Exec format error", use `git -c core.hooksPath=.husky/_ commit`.

---

### Task 1: Create the `wc_summary_paycheck_v` migration (aloha-data-migrations)

**Files:**
- Create: `aloha-data-migrations/supabase/migrations/20260724000000_wc_summary_paycheck_v.sql` (bump the `YYYYMMDDHHMMSS` prefix to the actual commit date if later)

**Interfaces:**
- Produces: prod view `public.wc_summary_paycheck_v(year int, month int, check_date date, wc_code text, pay_structure text, base_wages numeric, overtime numeric)`, granted to `anon, authenticated`.

- [ ] **Step 1: Write the migration file**

```sql
-- WC Wage Summary source for the Farm Dashboard WC/TDI page.
-- Per (check_date, wc class, pay structure) base-wage + overtime aggregates.
-- Base wages = gross - overtime_pay - per_diem - auto_allowance (same formula as
-- wc_basis_paycheck_v, so the summary reconciles with the monthly WC table).
-- Aggregate-only (no employee identity); mirrors the security posture of
-- wc_basis_* (definer view + anon SELECT). Idempotent: CREATE OR REPLACE.

CREATE OR REPLACE VIEW public.wc_summary_paycheck_v AS
SELECT
  EXTRACT(year  FROM check_date)::int AS year,
  EXTRACT(month FROM check_date)::int AS month,
  check_date,
  COALESCE(NULLIF(TRIM(BOTH FROM wc), ''), 'Unclassified') AS wc_code,
  pay_structure,
  round(sum(
    COALESCE(gross_wage, 0)
    - COALESCE(overtime_pay, 0)
    - COALESCE(per_diem, 0)
    - COALESCE(auto_allowance, 0)
  ), 2) AS base_wages,
  round(sum(COALESCE(overtime_pay, 0)), 2) AS overtime
FROM public.hr_payroll
WHERE COALESCE(is_deleted, false) = false
  AND payroll_processor <> 'HF'
  AND org_id = 'hawaii_farming'
GROUP BY 1, 2, 3, 4, 5;

COMMENT ON VIEW public.wc_summary_paycheck_v IS
  'Farm Dashboard WC Wage Summary source: per (check_date, wc class code, pay_structure) base-wage and overtime aggregates. base_wages = gross - overtime_pay - per_diem - auto_allowance (matches wc_basis_paycheck_v). Filters: not deleted, processor <> HF, org hawaii_farming. Aggregate-only (no employee identity).';

GRANT SELECT ON public.wc_summary_paycheck_v TO anon, authenticated;
```

- [ ] **Step 2: Sanity-check column names against a sibling view**

Run:
```bash
cd /c/Users/micha/Desktop/aloha-data-migrations
grep -nE "gross_wage|overtime_pay|per_diem|auto_allowance|pay_structure|payroll_processor|org_id" supabase/migrations/20260628234000_scope_wc_tdi_dashboard_to_org.sql | head
```
Expected: every column referenced in the new view (`gross_wage`, `overtime_pay`, `per_diem`, `auto_allowance`, `payroll_processor`, `org_id`) appears in the sibling view. (`pay_structure` was used by the dropped `hr_payroll_wc_summary` view — it exists on `hr_payroll`.)

- [ ] **Step 3: Commit**

```bash
cd /c/Users/micha/Desktop/aloha-data-migrations
git add supabase/migrations/20260724000000_wc_summary_paycheck_v.sql
git commit -m "feat(wc): wc_summary_paycheck_v — per check_date/class/structure base wages"
```
(If the hook errors, prefix with `git -c core.hooksPath=.husky/_`.)

---

### Task 2: Add the gated apply workflow + run the dry-run (aloha-data-migrations)

**Files:**
- Create: `aloha-data-migrations/.github/workflows/apply-wc-summary-paycheck-v.yml`

**Interfaces:**
- Consumes: the migration file from Task 1 (`MIG` path).
- Produces: a `workflow_dispatch` workflow that dry-runs (default) or applies the view to prod.

- [ ] **Step 1: Write the workflow (copy of the wc-audit house pattern, retargeted)**

```yaml
name: Apply wc_summary_paycheck_v (one-shot)

# Creates public.wc_summary_paycheck_v on prod — an aggregate-only view
# (GRANT SELECT TO anon, authenticated) powering the Farm Dashboard WC Wage
# Summary section on the WC/TDI page. No PII (aggregated per class/structure).
#
#   apply=false (default) → BEGIN…ROLLBACK dry-run (parses + builds, no writes)
#   apply=true            → --single-transaction psql apply; idempotent.

on:
  workflow_dispatch:
    inputs:
      apply:
        description: 'Actually apply (false = dry-run BEGIN...ROLLBACK)'
        required: true
        default: 'false'
        type: choice
        options: ['false', 'true']

jobs:
  apply:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      DEST_DB_URL: ${{ secrets.SUPABASE_DB_URL_PROD }}
      APPLY: ${{ inputs.apply }}
      MIG: supabase/migrations/20260724000000_wc_summary_paycheck_v.sql
    steps:
      - uses: actions/checkout@v5

      - name: Install postgresql-client-17
        run: |
          curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
            | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
          echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
            | sudo tee /etc/apt/sources.list.d/pgdg.list
          sudo apt-get update -y
          sudo apt-get install -y postgresql-client-17
          echo "/usr/lib/postgresql/17/bin" >> $GITHUB_PATH

      - name: Apply migration
        run: |
          set -e
          test -f "$MIG"
          if [ "$APPLY" = "true" ]; then
            (echo "SET search_path = public;"; cat "$MIG") \
              | psql "$DEST_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
          else
            { echo "SET search_path = public;"; echo "BEGIN;"; cat "$MIG"; echo "ROLLBACK;"; } \
              | psql "$DEST_DB_URL" -v ON_ERROR_STOP=1
          fi

      - name: Verify view exists + is queryable
        if: ${{ inputs.apply == 'true' }}
        run: |
          psql "$DEST_DB_URL" -At <<'SQL'
          SELECT 'wc_summary_paycheck_v rows: ' || count(*) FROM public.wc_summary_paycheck_v;
          SELECT 'distinct structures: ' || count(DISTINCT pay_structure) FROM public.wc_summary_paycheck_v;
          SQL
```

- [ ] **Step 2: Commit and push to main**

```bash
cd /c/Users/micha/Desktop/aloha-data-migrations
git add .github/workflows/apply-wc-summary-paycheck-v.yml
git commit -m "ci(wc): gated apply workflow for wc_summary_paycheck_v"
```
Push/merge to `main` per repo convention (the workflow must be on `main` to be dispatchable).

- [ ] **Step 3: Operator runs the dry-run**

Dispatch **Apply wc_summary_paycheck_v (one-shot)** with `apply=false`.
Expected: green run; the `Apply migration` step prints no errors (SQL parses, view builds inside the rolled-back transaction). This changes nothing on prod.

- [ ] **Step 4: Operator applies to prod**

Re-dispatch with `apply=true`.
Expected: green run; the verify step prints `wc_summary_paycheck_v rows: <N>` (N > 0) and `distinct structures: <M>` (M ≥ 1).

---

### Task 3: Register `wc_summary` in the farm-dash data source (farm-dash)

**Files:**
- Modify: `farm-dash/lib/data-source.js` (add a `wc_summary` entry to `CONFIG`, alongside `wc_basis_paycheck`)

**Interfaces:**
- Consumes: prod view `wc_summary_paycheck_v` (Task 1/2).
- Produces: `DataSource.fetchTable('wc_summary', { mode: 'prod' })` returning a gviz-shaped `{cols, rows}` with labels `Year, Month, Check, Code, Structure, Base, OT`.

- [ ] **Step 1: Add the CONFIG entry (place it right after the `wc_basis_paycheck` block)**

```js
    wc_summary: {
      sheets: [],
      supabase: {
        table: 'wc_summary_paycheck_v', orderBy: 'check_date',
        select: 'year,month,check_date,wc_code,pay_structure,base_wages,overtime',
        columns: [
          { label: 'Year',      field: 'year',          type: 'number' },
          { label: 'Month',     field: 'month',         type: 'number' },
          { label: 'Check',     field: 'check_date',    type: 'date'   },
          { label: 'Code',      field: 'wc_code',       type: 'string' },
          { label: 'Structure', field: 'pay_structure', type: 'string' },
          { label: 'Base',      field: 'base_wages',    type: 'number' },
          { label: 'OT',        field: 'overtime',      type: 'number' },
        ],
      },
    },
```

- [ ] **Step 2: Verify in the browser (requires Task 2 applied)**

Open `https://lfeder.github.io/farm-dash/wc-tdi/?src=prod` (or the local file with `?src=prod`), open devtools console, run:
```js
DataSource.fetchTable('wc_summary', { mode: 'prod' }).then(t => console.log(t.cols.map(c=>c.label), t.rows.length))
```
Expected: logs `['Year','Month','Check','Code','Structure','Base','OT']` and a row count > 0.

- [ ] **Step 3: Commit**

```bash
cd /c/Users/micha/Desktop/farm-dash
git add lib/data-source.js
git commit -m "feat(data-source): register wc_summary (wc_summary_paycheck_v)"
```

---

### Task 4: Render the summary section — markup, data plumbing, pivot table (farm-dash)

**Files:**
- Modify: `farm-dash/wc-tdi/index.html` (bump the `data-source.js?v=` cache-buster; add section markup below `#rulesNote`; add a `<script>`-scoped module that loads/parses/filters/scopes `wc_summary` and renders the pivot)

**Interfaces:**
- Consumes: `DataSource.fetchTable('wc_summary', { mode: 'prod' })` (Task 3).
- Produces (module-internal, reused by Task 5): `SUM_ROWS` — array of `{ y, m, check:{y,m,d}, iso:'YYYY-MM-DD', code, structure, base, ot }` filtered to the 6 most recent months with class code not empty/`N/A`/`Unclassified`; `sumMonthKeys()` and `sumOrderedDates()` helpers; `fmt`/`num` already exist on the page.

- [ ] **Step 1: Bump the data-source cache-buster**

In `wc-tdi/index.html`, change the script tag from `../lib/data-source.js?v=20260626e` to a new token, e.g. `../lib/data-source.js?v=20260724a`, so the new CONFIG entry is fetched (not the cached JS).

- [ ] **Step 2: Add the section markup** (immediately after the `<div class="note" id="rulesNote"></div>` line, before the main `<script>`)

```html
<h1 style="margin-top:34px">WC Wage Summary — by check date &amp; class</h1>
<div class="sub">Base wages (same basis as the monthly table above) · last 6 months · unclassified &amp; N/A excluded</div>
<div id="sumStatus" style="color:#8aa;padding:16px 0">Loading…</div>
<div class="bar" id="sumBar" style="display:none">
  <label class="capfld" for="sumDate">Check date
    <select id="sumDate" style="width:auto;text-align:left"></select>
  </label>
</div>
<div id="sumWrap" style="display:none; gap:24px; align-items:flex-start; flex-wrap:wrap">
  <div id="sumPivot" style="overflow:auto"></div>
  <div id="sumByCode" style="overflow:auto"></div>
  <div id="sumByStruct" style="overflow:auto"></div>
</div>
```

- [ ] **Step 3: Add the summary module** (append inside the existing `<script>`, after `load();`, or as a second `<script>` before `</body>`). This step: load, parse, filter, scope, and render the pivot.

```js
// ---- WC Wage Summary section (independent of the wc/tdi toggle) ----
const SUM_NULL = '—';
let SUM_ROWS = [], SUM_MONTHS = [], SUM_DATE = '';

function sumMonthKey(r) { return r.check.y + '-' + String(r.check.m).padStart(2, '0'); }
function sumMonthLabel(mk) { const [y, m] = mk.split('-'); return `${MN[+m]} ${yy(y)}`; }
function sumDateLabel(iso) { const [y, m, d] = iso.split('-'); return `${+m}/${+d}/${y}`; }

async function loadSummary() {
  let t;
  try { t = await DataSource.fetchTable('wc_summary', { mode: 'prod' }); }
  catch (e) { $('sumStatus').innerHTML = '<span style="color:#f5a">Summary load failed: ' + e + '</span>'; return; }

  const rows = parseTable(t).map(r => {
    const chk = parseDateV(r.Check);
    const iso = chk ? `${chk.y}-${String(chk.m).padStart(2, '0')}-${String(chk.d).padStart(2, '0')}` : '';
    return { y: num(r.Year), m: num(r.Month), check: chk, iso, code: r.Code, structure: r.Structure, base: num(r.Base), ot: num(r.OT) };
  }).filter(r => {
    const c = (r.code || '').trim().toUpperCase();
    return r.check && c !== '' && c !== 'N/A' && c !== 'UNCLASSIFIED';
  });

  // 6 most recent calendar months present.
  const months = [...new Set(rows.map(sumMonthKey))].sort((a, b) => b.localeCompare(a)).slice(0, 6);
  const keep = new Set(months);
  SUM_ROWS = rows.filter(r => keep.has(sumMonthKey(r)));
  SUM_MONTHS = months; // desc
  const dates = [...new Set(SUM_ROWS.map(r => r.iso))].sort((a, b) => b.localeCompare(a));
  SUM_DATE = dates[0] || '';

  if (!SUM_ROWS.length) { $('sumStatus').textContent = 'No workers-comp wage rows in the last 6 months.'; return; }
  $('sumStatus').style.display = 'none';
  $('sumBar').style.display = 'flex';
  $('sumWrap').style.display = 'flex';
  $('sumDate').innerHTML = dates.map(d => `<option value="${d}"${d === SUM_DATE ? ' selected' : ''}>${sumDateLabel(d)}</option>`).join('');
  $('sumDate').onchange = () => { SUM_DATE = $('sumDate').value; renderSummaryDetail(); };
  renderSummaryPivot();
  renderSummaryDetail();
}

function renderSummaryPivot() {
  const codes = [...new Set(SUM_ROWS.map(r => r.code))].sort();
  let h = '<table><thead><tr><th class="lbl">Period Month</th><th class="lbl">Check Date</th><th class="lbl">Class Code</th><th>Base</th><th>OT</th></tr></thead><tbody>';
  let gB = 0, gO = 0;
  SUM_MONTHS.forEach(mk => {
    const inMonth = SUM_ROWS.filter(r => sumMonthKey(r) === mk);
    const dates = [...new Set(inMonth.map(r => r.iso))].sort((a, b) => b.localeCompare(a));
    let mB = 0, mO = 0, firstOfMonth = true;
    dates.forEach(iso => {
      const inDate = inMonth.filter(r => r.iso === iso);
      const byCode = {}; inDate.forEach(r => { (byCode[r.code] = byCode[r.code] || { b: 0, o: 0 }); byCode[r.code].b += r.base; byCode[r.code].o += r.ot; });
      const dCodes = Object.keys(byCode).sort();
      let dB = 0, dO = 0, firstOfDate = true;
      dCodes.forEach(c => {
        const v = byCode[c]; dB += v.b; dO += v.o;
        h += `<tr><td class="lbl">${firstOfMonth ? sumMonthLabel(mk) : ''}</td><td class="lbl">${firstOfDate ? sumDateLabel(iso) : ''}</td><td class="lbl">${c}</td><td>${fmt(v.b)}</td><td>${fmt(v.o)}</td></tr>`;
        firstOfMonth = false; firstOfDate = false;
      });
      mB += dB; mO += dO;
      h += `<tr class="roll"><td class="lbl"></td><td class="lbl">${sumDateLabel(iso)} total</td><td></td><td>${fmt(dB)}</td><td>${fmt(dO)}</td></tr>`;
    });
    gB += mB; gO += mO;
    h += `<tr class="roll"><td class="lbl">${sumMonthLabel(mk)} total</td><td></td><td></td><td>${fmt(mB)}</td><td>${fmt(mO)}</td></tr>`;
  });
  h += `<tr class="tot"><td class="lbl">Last 6 months</td><td></td><td></td><td>${fmt(gB)}</td><td>${fmt(gO)}</td></tr></tbody></table>`;
  $('sumPivot').innerHTML = h;
}

loadSummary();
```

- [ ] **Step 4: Verify the pivot renders** (Task 2 applied, Task 3 committed)

Open `wc-tdi/?src=prod`. Scroll to the new "WC Wage Summary" heading.
Expected: a pivot table appears with Period Month / Check Date / Class Code / Base / OT; per-date and per-month subtotal rows (`.roll` shaded); a bold "Last 6 months" total row (`.tot`). Cross-check: the "Last 6 months" Base total ≈ sum of the last 6 monthly Base values in the "Workers' Comp · monthly" table above (same base-wage basis; small differences only if the monthly view's 12-mo window or N/A handling differs — class N/A is excluded in both).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/micha/Desktop/farm-dash
git add wc-tdi/index.html
git commit -m "feat(wc-tdi): WC Wage Summary section — pivot by month/date/class"
```

---

### Task 5: Per-check-date By-Class and By-Structure summary tables (farm-dash)

**Files:**
- Modify: `farm-dash/wc-tdi/index.html` (add `renderSummaryDetail()` used by the date `<select>` and initial load in Task 4)

**Interfaces:**
- Consumes: `SUM_ROWS`, `SUM_DATE`, `fmt`, `sumDateLabel`, `SUM_NULL` (Task 4).
- Produces: fills `#sumByCode` and `#sumByStruct` for the selected `SUM_DATE`.

- [ ] **Step 1: Add `renderSummaryDetail()`** (place it just above the `loadSummary()` call so the initial `renderSummaryDetail()` in `loadSummary` resolves)

```js
function sumAggregate(rows, keyOf) {
  const m = {};
  rows.forEach(r => { const k = keyOf(r) || SUM_NULL; (m[k] = m[k] || { b: 0, o: 0 }); m[k].b += r.base; m[k].o += r.ot; });
  const lines = Object.keys(m).sort((a, b) => (a === SUM_NULL) - (b === SUM_NULL) || a.localeCompare(b))
    .map(k => ({ label: k, b: m[k].b, o: m[k].o }));
  const tot = lines.reduce((a, l) => ({ b: a.b + l.b, o: a.o + l.o }), { b: 0, o: 0 });
  return { lines, tot };
}

function sumDetailTable(title, firstHeader, agg) {
  let h = `<div class="muted" style="margin-bottom:4px">${title}</div>`;
  h += `<table><thead><tr><th class="lbl">${firstHeader}</th><th>Base</th><th>OT</th></tr></thead><tbody>`;
  agg.lines.forEach(l => { h += `<tr><td class="lbl">${l.label}</td><td>${fmt(l.b)}</td><td>${fmt(l.o)}</td></tr>`; });
  h += `<tr class="tot"><td class="lbl">TOTAL</td><td>${fmt(agg.tot.b)}</td><td>${fmt(agg.tot.o)}</td></tr>`;
  h += '</tbody></table>';
  return h;
}

function renderSummaryDetail() {
  const rows = SUM_ROWS.filter(r => r.iso === SUM_DATE);
  const label = SUM_DATE ? sumDateLabel(SUM_DATE) : '—';
  $('sumByCode').innerHTML = sumDetailTable(`By class code · ${label}`, 'Class Code', sumAggregate(rows, r => r.code));
  $('sumByStruct').innerHTML = sumDetailTable(`By structure · ${label}`, 'Structure', sumAggregate(rows, r => r.structure));
}
```

- [ ] **Step 2: Verify the detail tables** (Task 2 applied)

Open `wc-tdi/?src=prod`. Beside the pivot, two tables show for the most-recent check date: **By class code** and **By structure**, each ending in a bold `TOTAL` row. Change the "Check date" dropdown → both tables update to the chosen date. A blank pay structure shows as `—` sorted last. Cross-check: the By-class TOTAL for a date equals that date's subtotal row in the pivot.

- [ ] **Step 3: Commit**

```bash
cd /c/Users/micha/Desktop/farm-dash
git add wc-tdi/index.html
git commit -m "feat(wc-tdi): per-check-date by-class and by-structure summary tables"
```

---

## Self-Review Notes

- **Spec coverage:** new view (Tasks 1–2); data-source registration (Task 3); pivot Month→Check Date→Class Code with subtotals + "Last 6 months" total (Task 4); check-date selector + By-Class + By-Structure with TOTAL rows (Task 5); base wages everywhere (Global Constraints + Task 1); 6-month scope, drop null/N/A/Unclassified, calendar-month grouping (Task 4). Out-of-scope items (CSV export, cap params, renewal split) intentionally omitted.
- **Type consistency:** `SUM_ROWS` row shape, `sumMonthKey`/`sumDateLabel`/`SUM_NULL`, and the `{lines,tot}` aggregate shape are defined in Task 4 and consumed unchanged in Task 5. Data-source labels (`Year/Month/Check/Code/Structure/Base/OT`) match between Task 3's CONFIG and Task 4's `parseTable` field reads.
- **No automated tests** exist in these repos; each task's verification is a concrete manual/CI check with an expected result, which is the honest testing model here.
