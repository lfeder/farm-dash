# Merge WC Annual Audit into the WC/TDI page

**Date:** 2026-07-24
**Repo:** farm-dash
**Status:** Approved design, implementing directly (contained 2-file UI change)

## Goal

Remove the standalone "WC Annual Audit" top-level dashboard tab and surface the
audit inside the WC/TDI page as one of three top-level panels, so the home nav
carries a single WC tab.

## Decisions (locked)

1. **Layout:** a top tab bar on the WC/TDI page with three panels —
   **Insurer Reporting | Wage Summary | Annual Audit**. One panel visible at a
   time. Wage Summary moves from the always-visible bottom section into its own
   tab.
2. **Audit integration:** embed the existing `wc-audit/index.html` via an
   `<iframe>` (single maintained source, no JS de-dup). The audit keeps its own
   year picker / sub-tabs / CSV inside the frame.

## Changes

### `index.html` (home shell)

- Remove the `{ id: 'wc-audit', label: 'WC Annual Audit', src: 'wc-audit/index.html' }`
  entry from the `DASHBOARDS` array.
- Bump `BUILD_VER` (and the matching `data-source.js?v=` on the shell's own
  script tag is unrelated — leave it) so the shell re-fetches the updated
  `wc-tdi` sub-page rather than a cached copy.
- `wc-audit/index.html` stays on disk — it is now embedded, not a top-level tab.

### `wc-tdi/index.html`

- **CSS:** add the `.tabs`, `.tabs button`, `.tabs button:hover`,
  `.tabs button.active`, `.panel`, `.panel.active` rules (copied verbatim from
  `wc-audit/index.html`'s style block so styling matches).
- **Structure:** replace the current top of `<body>` with:
  - `<h1>Workers' Comp &amp; TDI</h1>` (page title; the old
    "… — Insurer Reporting" h1 is removed, its role taken by the tab label).
  - A tab bar `#secTabs` with buttons `Insurer Reporting` (default active),
    `Wage Summary`, `Annual Audit`.
  - **Panel `reporting`** (default active): the existing `.sub` (#sub, dynamic
    source line), `.bar` (#viewSeg toggle + cap field + Export CSV), `#status`,
    `#pills`, `#main`, `.note#rulesNote` — internals unchanged, just wrapped.
  - **Panel `wage`**: the existing WC Wage Summary markup (its `.sub`,
    `#sumStatus`, `#sumBar`/`#sumDate`, `#sumWrap` with `#sumPivot`/`#sumByStruct`).
    Drop the section's own `<h1>` (redundant with the tab label).
  - **Panel `audit`**: `<iframe id="auditFrame">` (empty `src` until first open),
    styled `width:100%; height:calc(100vh - 120px); border:0; display:block`.
- **JS (append to the existing single `<script>`, reusing its scope):**
  - `const AUDIT_V = '20260724b';` cache-buster token for the embedded audit HTML.
  - `function showSection(p)` — toggles `.active` on `#secTabs button` and on
    `.panel[data-panel]`; on first activation of `audit`, sets
    `auditFrame.src = '../wc-audit/index.html?src=' + DataSource.getMode() + '&v=' + AUDIT_V`
    (lazy; guarded by a flag so it sets src once).
  - Wire `#secTabs button` clicks to `showSection(btn.dataset.p)`; default to
    `reporting`.
  - `load()` (reporting) and `loadSummary()` (wage) keep running on page load, so
    those panels are populated before selection; only the audit fetch is deferred.

## Non-goals

- No change to the audit's computations, data sources, or its internal sub-tabs.
- No change to the reporting or wage-summary computations.
- No deletion of `wc-audit/index.html`.
- No deep-linking to a specific tab (defaults to Insurer Reporting each load).

## Verification

- Inline `<script>` still parses (extract + syntax-check).
- No duplicate `id`s introduced; no dangling references.
- Manual/browser (prod view already applied): three tabs switch; default is
  Insurer Reporting and looks identical to today; Wage Summary matches the
  compact version just shipped; Annual Audit loads the embedded page reading
  prod (`?src=prod` passed through); the old top-level "WC Annual Audit" nav tab
  is gone.
