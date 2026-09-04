# Archive: when the schedule was a Google Sheet

**Historical. Nothing here describes how the page works now.**

Until **2026-09-03** the logistics schedule lived in a Google Sheet
(`1JesEFq8X3tVDYi4_SbLs3u1lnG8Ch7NbiR7CvGlZS7Q`, gid `578288022`). The built
page fetched it on every load, so editing the sheet and refreshing the browser
was the whole loop; `legs.csv` was the committed snapshot the page fell back to
when the sheet could not be reached, and `build.py` refreshed it on every build.

It now lives in Postgres — `pack_journey`, `pack_journey_leg`,
`pack_freight_gate`, `pack_sailing` — and is edited in the page's own **Edit**
tab. See the README. **The sheet is no longer read by anything, and edits made
there will not appear on the dash.**

This file is kept because the reasoning below explains why several things in
`reference.json` and `viewer/app.js` are shaped the way they are, and because
`legs.csv` is still written in the sheet's grid shape.

---

## The two shapes the reader accepted

The sheet came in either of two shapes and the viewer read both. `legs.csv`
is still written in the second one, so the fallback path is exercised by the
reader that has always been there rather than by a second one written to be
used only when something is broken.

**A row per leg** — a header naming `Leg`/`Step` and `Start dt`, then one row
per step with its own `Crop`, `FOB`, `Transport` columns.

**The grid** — steps down the side in the order the chart draws them, journeys
across the top, and a cell saying when that step ran. A journey is a column:

```
Crop          Lettuce           Lettuce
FOB           140               Off-island
Transport     Air               Barge
Start Day     0                 0
Pack/Store 1  Sun 10:00-14:00   Sun 14:00-18:00
```

The identity block was the one **above the first step row**; after that, a
label was a step whatever else it also named. That rule existed because
`Transport` is both a thing a journey *is* and a step it *takes*.

## Rules that came from the sheet and still hold

**The sheet's row order was the chart's row order.** `reference.json` only said
where a step goes when the sheet did not mention it, so reordering rows in the
sheet reordered the lanes and there were not two lists to keep in step.

*Now:* `pack_journey_leg.step_order` carries this, seeded from the
`reference.json` step order.

**Every step was a row, always** — whether or not the journeys on screen used
one. The rows then stayed put as journeys were switched on and off, and an
empty row said what an empty cell said: this one skips it.

**Where a step runs between was not in the sheet.** It is the same on every
journey, so it lives in `reference.json` under `steps` — and where it does
depend on the journey, `transport` or `fob` overrides it. Still true; this is
why `pack_journey_leg` stores a step and a time but no places.

**Branch 2 was not written in the sheet.** Test and hold is the same chain on
every journey, so it is written once in `reference.json` and grown onto every
journey from the moment packing ends. Branch 2 rows in the sheet were ignored.
Still true, and still why `pack_journey_leg.branch` is written by nothing.

**A typo could not blank the page.** The reader refused a sheet it could not
trust and said which row — a bad time, a day that is not a day, a header naming
no journey — then drew the committed `legs.csv` instead and printed the reason
above the chart. The same fallback now applies to the database being
unreachable.

## What was deliberately not built, and has since been built

> *This is a viewer. Editing a journey means editing the sheet. Interactive
> editing was tried and taken back out — the builder was becoming the product.*

That was the position while the sheet was the editing surface, and it was the
right one: a second editor competing with Google Sheets would have been a worse
Google Sheets. Moving the schedule into Postgres removed the thing it was
weighing against — there was no longer *any* editor — so the Edit tab was built
on 2026-09-03.
