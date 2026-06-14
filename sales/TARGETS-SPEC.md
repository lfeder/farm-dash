# Targets Dashboard Specification

## 1. Overview

Budget goal tracker for the sales force. Displays weekly cases sold vs. budget targets for each product, plus pounds-per-day grown vs. sold for each crop category. The page is titled "Targets" (both browser tab and header). The header displays `h1` text "Targets" in teal (#4ecca3) on a dark background (#16213e), sticky at top.

---

## 2. Data Sources

### Invoice Data
- Google Sheet ID: `124y8JdWXmbf_hb1vfimHmGaKLVXrRHybw02w_ozCExE`
- Two tabs fetched by GID: `1254110782`, `544460225`
- Query filters out rows where ProductCode = `'Sales'` and CustomerName = `'Kaukau 4 Keiki'`
- Columns used: `InvoiceDate` (A), `ProductCode` (B), `Cases` (C), `Year` (D), `CustomerName` (J)
- Only years 2025 and 2026 are kept
- Each row stored as `{d: InvoiceDate, p: ProductCode, c: Cases}`

### Grow Data — Cucumber Harvest
- Google Sheet ID: `1VtEecYn-W1pbnIU1hRHfxIpkH2DtK7hj0CpcpiLoziM`
- Tab: `grow_C_harvest`
- Query: year 2026 only, varieties K, J, or E
- Columns: `HarvestDate` (A), `Variety` (H), `Grade` (I), `GreenhouseNetWeight` (L)
- Stored as `{d, v, g, lb}`

### Grow Data — Lettuce
- Same sheet, tab: `grow_L_seeding`
- Query: year 2026 only (via `YEAR(N)=2026`)
- Columns: `HarvestDate` (N), `Variety` (D), `GreenhouseNetWeight` (P)
- Stored as `{d, v, lb}`, filtered to rows where `d` and `lb > 0`

### Budget Data
- Hardcoded 52-week arrays per product in the HTML (see section 15)

### Fetch Script
- `sales/fetch-budget-data.js` — Node.js script
- Fetches all three data sources via Google Sheets CSV export (`gviz/tq?tqx=out:csv`)
- Saves to `sales/budget-data.json` with structure: `{ts, invoices, cukeGrow, lettuceGrow}`
- `ts` is ISO timestamp of when fetch ran
- Run manually: `node sales/fetch-budget-data.js`

---

## 3. Week Definition

Uses a **Saturday-to-Friday** week system via `satFriWeek(d)`.

### How satFriWeek Works
1. Find January 1 of the date's year
2. Find the first Saturday on or after Jan 1: `firstSat = Jan 1 + ((6 - jan1.getDay() + 7) % 7)` days
3. For 2026: Jan 1 is Thursday, so first Saturday is Jan 3
4. If the date falls before the first Saturday, it's week 1
5. Otherwise: `week = floor((date - firstSat) / 7 days) + 2`

### Week 1 Exclusion
- Week 1 (Jan 1-2 for 2026) is excluded from all charts as a short holiday week
- Charts display weeks 2 through 52 (51 weeks total)
- The `WEEKS` array: `[2, 3, 4, ..., 52]`

### Week Date Ranges
- Each week label maps to its Saturday-Friday date range
- Computed via `weekDateRange(wk)` using the first Saturday of 2026 as anchor
- Format: `M/D-M/D` (e.g., `1/3-1/9`)

---

## 4. Data Processing

### Invoice Aggregation (`processInvoices`)
- Input: array of `{d, p, c}` (date, product code, cases)
- Parses date, computes `satFriWeek` to get year and week
- Accumulates into `actuals[productCode][year][week]` (sum of cases)
- Both 2025 and 2026 data are kept (2025 for prior-year comparison)

### Grow Data Processing (`processGrow`)

**Cucumber rows** (`{d, v, g, lb}`):
- Only **grade 1** rows (`String(r.g) !== '1'` filters others)
- Variety first character maps to category: `K` = Keiki, `J` = Japanese, `E` = English
- Pounds accumulated by week into `grownLbDay[category][week]`

**Lettuce rows** (`{d, v, lb}`):
- Variety mapping:
  - `GA` = Arugula
  - `WC` = Watercress
  - Everything else = Lettuce
- Pounds accumulated by week into `grownLbDay[category][week]`

**Conversion to lb/day**: All weekly pound totals are divided by 7 and rounded: `Math.round(lb / 7)`

### Helper Functions
- `getBdg(codes, w)` — sum budget values for given product codes at week `w` (0-indexed array, so `w-1`)
- `getAct(codes, yr, w)` — sum actuals for given codes, year, and week
- `cumulate(arr)` — running cumulative sum of an array

---

## 5. Chart Layout

### Section Order
1. **Pounds per Day** — lb/day charts for each crop category
2. **Cases by Product** — individual product charts in grouped rows
3. **Summary** — aggregated cases charts for Keikis, Japanese, Greens

### Lb/Day Grid
- 3-column grid (`cols-3`)
- One chart per category: Keiki, Japanese, English, Lettuce, Watercress, Arugula
- All categories from `CATEGORIES` object rendered in order

### Product Grid — Row Groupings
Each row is a 3-column grid (`cols-3`), with rows:

| Row | Products |
|-----|----------|
| 1   | KW, KR |
| 2   | JW, JR, EF |
| 3   | LW, LR, LF |
| 4   | WR, WF |
| 5   | AR, AF |

Rows with fewer than 3 items leave empty grid cells. Each row has `margin-bottom: 12px`.

### Summary Grid
- 3-column grid (`cols-3`), `margin-top: 12px`
- Three charts: **Keikis** (KW+KR+KF), **Japanese** (JW+JR+JF), **Greens** (LW+LR+LF)

---

## 6. Chart Design — Split Layout

Every chart uses a **split layout**: top portion for main data, bottom portion for variance/difference.

### Container
- `.chart-box.split`: `height: 250px`, `display: flex; flex-direction: column`, `padding-bottom: 0`
- Background: `#16213e`, border: `1px solid #2a3a5e`, border-radius: `8px`, padding: `12px`

### Flex Ratios
- `.chart-top`: `flex: 5` (main chart area)
- `.chart-btm`: `flex: 3` (sub-chart area)
- Both have `min-height: 0; position: relative; overflow: hidden`

### Divider
- `border-bottom: 1px solid #2a3a5e` on `.chart-top` separates the two sections

### Title
- HTML `div.chart-title` above both chart areas (not canvas-rendered)
- `text-align: center; font-size: 0.85rem; font-weight: 600; color: #ccc; padding: 4px 0 0`

---

## 7. Chart Styling Details

### Legends
- **No per-chart legends** — `legend: { display: false }` on all charts
- Shared legends are displayed in section headers (see section 10)

### Titles
- Chart.js `title` plugin is disabled (`display: false`)
- Titles are rendered as **HTML divs** above the canvas, not on canvas

### Font Sizes
- Y-axis tick labels: `font: { size: 11 }`
- X-axis tick labels: `font: { size: 11 }`
- Tooltip body: `bodyFont: { size: 11 }`
- Tooltip title: `titleFont: { size: 12 }`

### Grid Lines
- **No vertical grid lines**: top chart x-axis has `grid: { display: false }`
- Horizontal grid: `color: 'rgba(255,255,255,0.05)'` (very faint)

### Y-Axis Behavior
- **Top lb/day charts**: `grace: '10%'` (does NOT use beginAtZero)
- **Top cases charts**: `grace: '10%'` (does NOT use beginAtZero)
- Both use `maxTicksLimit: 5`

### afterFit Width
- All Y-axes use `afterFit(axis) { axis.width = 50 }` to ensure consistent left alignment across charts

### X-Axis on Top Charts
- Ticks hidden: `ticks: { display: false }`
- Grid hidden: `grid: { display: false }`
- (X-axis labels only show on bottom sub-charts)

### Responsive
- `responsive: true, maintainAspectRatio: false` on all charts
- Mobile breakpoint at 900px: grids collapse to single column, chart height becomes 240px

---

## 8. Series Colors

### Cases Charts (Top)
| Series | Color | Details |
|--------|-------|---------|
| Bdg26 (Budget) | `#ff0000` (red) | `borderWidth: 1.5`, `stepped: 'before'`, `pointRadius: 0` |
| Act26 (Actual 2026) | `#0066ff` (blue) | `borderWidth: 2`, `pointRadius: 0`, `spanGaps: false` |
| Act25 (Actual 2025) | `rgba(0,204,0,0.5)` (semi-transparent green) | `borderWidth: 1.5`, `pointRadius: 0`, hidden by default |

### Lb/Day Charts (Top)
| Series | Color | Details |
|--------|-------|---------|
| Grown | `#00cc00` (green) | `borderWidth: 2`, `pointRadius: 0` |
| Sold | `#0066ff` (blue) | `borderWidth: 2`, `pointRadius: 0` |

### Cumulative Variance (Cases Bottom Sub-chart)
- Line color: green `rgba(78,204,163,0.4)` when above zero, red `rgba(231,76,60,0.4)` when below zero
- Fill above origin: `rgba(78,204,163,0.25)` (green)
- Fill below origin: `rgba(231,76,60,0.25)` (red)
- Segment coloring via `segment.borderColor` callback checks `p0.parsed.y >= 0 && p1.parsed.y >= 0`

### Unsold (Lb/Day Bottom Sub-chart)
- Line color: `rgba(136,136,136,0.3)` (grey)
- Fill (both above and below origin): `rgba(136,136,136,0.2)` (grey)

---

## 9. Bottom Sub-charts

### Cases Sub-chart (Cumulative Variance ± Budget)
- Data: `cumA26[i] - cumBdg[i]` for completed weeks, `null` after MAX_WEEK
- Positive values = ahead of budget (green fill), negative = behind (red fill)
- Label: `± Budget`
- `spanGaps: false`

### Lb/Day Sub-chart (Unsold)
- Data: `grown[i] - sold[i]` for completed weeks, `null` after MAX_WEEK
- Grey fill regardless of sign direction
- Label: `Unsold`
- `spanGaps: false`

### Shared Sub-chart Axis Configuration

**Y-axis (`btmYScale`)**:
- Only shows `"0"` label: `callback: v => v === 0 ? '0' : ''`
- Zero line visible: grid color returns `rgba(255,255,255,0.3)` for value 0, `transparent` otherwise
- `drawTicks: false`
- `afterFit: axis.width = 50` (matches top chart)
- `afterBuildTicks`: ensures a tick at 0 always exists — if not present, pushes `{value: 0}` and re-sorts

**X-axis (`btmXScale`)**:
- Tick color: `#888`, font size: 11, `maxTicksLimit: 13`, `maxRotation: 0`
- Grid: `display: false`
- Border: `display: true`, color: `rgba(255,255,255,0.2)`

---

## 10. Section Headers

### Structure
- `div.section-header`: teal text (#4ecca3), `font-size: 1.05rem`, flex layout with `gap: 16px`
- Contains section title text + `div.section-legend`

### Lb/Day Legend
- Colored dots (8x8px circles): **Grown** (green #00cc00), **Sold** (blue #0066ff)
- Separator: `|` in `#666`
- **Unsold** (grey #888)

### Cases Legend
- **Bdg26** (red #ff0000), **Act26** (blue #0066ff), **Act25** (semi-transparent green `rgba(0,204,0,0.5)`)
- Separator: `|` in `#666`
- **± Budget** dot: `background: linear-gradient(to right, #4ecca3 50%, #e74c3c 50%)` — half green, half red

### Act25 Toggle
- The Act25 legend item is clickable (`cursor: pointer`, `onclick="toggle25()"`)
- Default state: `opacity: 0.4` (dimmed = hidden)
- Active state: `opacity: 1` (full brightness = visible)
- Element ID: `act25Toggle`

---

## 11. Interactions

### Act25 Toggle (`toggle25()`)
- Toggles global `show25` boolean
- Updates `act25Toggle` element opacity (0.4 when off, 1 when on)
- Iterates all charts, finds datasets with `year: 2025` property, toggles visibility via `chart.setDatasetVisibility(i, show25)` then `chart.update()`

### Tooltips
- Mode: `index` (all series at same x position), `intersect: false`
- Title format: `Wk {weekNum}  ({M/D-M/D})` — e.g., `Wk 12  (3/14-3/20)`
- Two spaces between week number and date range parentheses

### Chart Interaction
- All charts: `interaction: { mode: 'index', intersect: false }`
- No click handlers on individual charts (only the legend toggle)

---

## 12. Week Cutoff

### MAX_WEEK Calculation (`maxWeek()`)
- Determines the latest **completed** week to display data for
- Converts current time to HST by subtracting 10 hours from UTC
- Gets current week number via `satFriWeek(hst).week`
- Rule: show a week only after it ends
  - **Friday after 3pm HST**: current week is considered complete, return `cur`
  - **All other times** (Sat, Sun, Mon, Tue, Wed, Thu, Fri before 3pm): return `cur - 1`
- Stored as constant `MAX_WEEK` at page load

### Effect on Data
- Act26 data: mapped to `null` for weeks after MAX_WEEK
- Cumulative variance: mapped to `null` for weeks after MAX_WEEK
- Grown/Sold lb/day: mapped to `null` for weeks after MAX_WEEK
- Budget line always shows all 52 weeks (full year target)
- Act25 data: always shows all weeks (prior year is complete)

---

## 13. Data Caching

### Pre-fetched JSON
- Dashboard loads `budget-data.json` via `fetch('budget-data.json')`
- JSON structure: `{ ts: ISO_string, invoices: [...], cukeGrow: [...], lettuceGrow: [...] }`

### Status Display
- After load, header shows: `YTD through week {MAX_WEEK} | data: MM/DD HH:MM`
- Data timestamp comes from `data.ts` in the JSON
- Format: `data: MM/DD HH:MM` (zero-padded)

### Loading UI
- Progress bar with three stages: 30% "Loading data...", 60% "Processing...", 90% "Rendering charts..."
- Green bar (#4ecca3) on dark track (#0f3460), animated width transition (0.3s)
- Loading overlay hidden after render completes
- On error: loading text replaced with `Error: {message}`

---

## 14. Products

### Product Codes
`KW, KR, JW, JR, EF, LW, LR, LF, WR, WF, AR, AF`

Note: `KF`, `JF`, `WF` exist in budget/category definitions but are not in the `PRODUCTS` array (no individual charts rendered for them).

### LB_PER_CASE Values
| Code | Lb/Case |
|------|---------|
| KW | 16 |
| KR | 12 |
| KF | 12 |
| JW | 14 |
| JR | 14 |
| JF | 14 |
| EF | 15 |
| LW | 10.5 |
| LR | 2.25 |
| LF | 10 |
| WR | 2.25 |
| WF | 10 |
| AR | 2.25 |
| AF | 10 |

### Category Groupings
| Category | Products |
|----------|----------|
| Keiki | KW, KR, KF |
| Japanese | JW, JR, JF |
| English | EF |
| Lettuce | LW, LR, LF |
| Watercress | WR, WF |
| Arugula | AR, AF |

### Variety-to-Category Map
Used for grow data: `K` = Keiki, `J` = Japanese, `E` = English, `L` = Lettuce, `W` = Watercress, `A` = Arugula

---

## 15. Budget Data

52-week hardcoded arrays per product (index 0 = week 1, index 51 = week 52). All values are in cases.

| Product | Pattern |
|---------|---------|
| KW | 1300 (wk1-4), 1400 (wk5-10), 1550 (wk11-47), 1300 (wk48-52) |
| KR | 950 (wk1-4), 1050 (wk5-7), 1150 (wk8-25,31-47), 1500 (wk26-30), 950 (wk48-52) |
| KF | 25 flat all 52 weeks |
| JW | 550 (wk1-15,48-52), 800 (wk16-47) |
| JR | 450 flat all 52 weeks |
| JF | 0 flat all 52 weeks |
| EF | 125 (wk1-13,46-52), 275 (wk14-45) |
| LW | 550 (wk1-6), 600 (wk7-46), 510 (wk47-52) |
| LR | 200 (wk1-16), 225 (wk17-26), 250 (wk27-36), 275 (wk37-46), 300 (wk47-52) |
| LF | 65 (wk1-6), 75 (wk7-16), 85 (wk17-26), 95 (wk27-36), 110 (wk37-46), 125 (wk47-52) |
| WR | 125 (wk1-6), 150 (wk7-16), 175 (wk17-26), 200 (wk27-36), 210 (wk37-46), 225 (wk47-52) |
| WF | 0 flat all 52 weeks |
| AR | 25 (wk1-6), 50 (wk7-16), 100 (wk17-26), 150 (wk27-36), 200 (wk37-46), 225 (wk47-52) |
| AF | 10 (wk1-6), 15 (wk7-16), 20 (wk17-26), 30 (wk27-36), 40 (wk37-46), 50 (wk47-52) |

---

## 16. Naming

- Browser tab title: **Targets**
- Header h1: **Targets**
- Summary chart titles: **Keikis**, **Japanese**, **Greens**
- Section headers: "Pounds per Day", "Cases by Product"
- Legend labels: Bdg26, Act26, Act25, Grown, Sold, Unsold, ± Budget

---

## 17. Version Stamp

The parent `index.html` auto-reads its own `last-modified` HTTP header on load and displays the timestamp in the nav bar.

---

## 18. Editable Budget

- **Edit Budget** toggle button in header — click to enter edit mode
- In edit mode, red dots appear on the Bdg26 line of each **product chart** (not summaries)
- **Drag a dot** up/down to set a new budget value for that week (rounds to integer)
- Only the Bdg26 dataset (index 0) is draggable — other datasets have `dragData: false`
- Uses `chartjs-plugin-dragdata` v2.3.0 CDN
- After each drag:
  - The BUDGET array is updated in memory
  - Summary charts (Keikis, Japanese, Greens) are destroyed and re-rendered with new totals
  - lb/day charts are destroyed and re-rendered (budget lb line updates)
- **Save Budget** button appears when budget is modified — downloads `budget-updated.json` containing the modified BUDGET object
- User commits the downloaded file to the repo for other viewers to see
- `dragData: false` is set on all charts by default — only enabled per-chart when Edit Budget is active

---

## 19. Cumulative Variance in Top Chart

The top cases chart includes a **± Budget** dataset on the right Y-axis (`y1`):
- Data: `cumulative Act26 - cumulative Bdg26` per week (null after MAX_WEEK)
- Filled to origin: green (`rgba(78,204,163,0.15)`) when ahead, red (`rgba(231,76,60,0.15)`) when behind
- Segment border color: green when both points ≥ 0, red otherwise
- Right Y-axis (`y1`): ticks hidden, no grid, `afterFit` width 0 so it takes no space
- This is in addition to the separate bottom sub-chart which shows the same data more prominently

---

## 20. Budget lb/day Line

The lb/day top charts include a **Bdg lb** line:
- Computed: `sum(BUDGET[product][week-1] * LB_PER_CASE[product]) / 7` for all products in the category
- Styled: red (`#ff0000`), dashed (`borderDash:[4,3]`), stepped, borderWidth 1
- Updates when budget is edited (charts re-rendered)
- Legend callout in section header: red dot with 60% opacity

---

## 21. Light Mode

- Toggle button in header (☀/🌙)
- CSS variables control all colors: `--bg`, `--bg2`, `--bg3`, `--border`, `--text`, `--text2`, `--accent`, `--grid`, `--xborder`
- Dark (default): `#1a1a2e` bg, `#16213e` cards, `#e0e0e0` text, `#4ecca3` accent
- Light: `#f0f2f5` bg, `#ffffff` cards, `#1a1a2e` text, `#0a8a64` accent
- On toggle, chart axis tick/grid colors are updated in-place and charts refreshed (no full re-render)

---

## 22. Bottom Sub-Chart Zero Centering

The bottom sub-charts (± Budget and Unsold) use a symmetric Y-axis range:
- `makeBtmYScale(data)` computes `maxAbs = max(|values|)`
- Sets `min: -maxAbs, max: +maxAbs`
- This ensures the zero line is always vertically centered in the sub-chart
- The "0" label is always visible via `callback: v => v === 0 ? '0' : ''`
- `afterFit` forces width to 50px to match the top chart's Y-axis width
