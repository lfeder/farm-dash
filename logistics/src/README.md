# Logistics Map

A time–distance chart of how product gets from the packhouse to the customer.

```
python3 build.py      # Postgres + reference.json + orders.json -> ../index.html
open ../index.html
```

**A schedule edit needs no build.** The page reads Postgres on every load and
the **Edit** tab writes back to it, so changing a time is: open the tab, change
the field, done. The build is for changing the page itself, and for refreshing
the snapshot the page falls back to when the database cannot be reached.

> Until 2026-09-03 the schedule was a Google Sheet. It is no longer read by
> anything — edits there will not appear on the dash.

## Where things live

| File / table | What it is |
|---|---|
| `pack_journey`, `pack_journey_leg` | **The schedule**, in Postgres (prod). One row per journey and one per step. Edited in the page's Edit tab. |
| `pack_freight_gate`, `pack_sailing` | Somebody else's door and when it opens; which boat goes where. Also edited in the Edit tab. |
| `legs.csv` | A snapshot of the two journey tables, rewritten by every build. Committed, so the diff shows what changed and the page still draws with no network. **Active journeys only** — a journey switched off stays off. |
| `reference.json` | Two halves. Hand-edited: `steps` (lane order and place-pair overrides), `hold` (test-and-hold recipes), `sites`, `start_days`, `packed_from`. Generated, like `legs.csv`: `hours` and `sailings`. |
| `orders.json` | Pulled, not typed. Cases and pounds on order by destination, and the pack line's case counts. Copied out of the freight model's `data.json` — refresh it there. |
| `build.py` | Pulls the four tables, writes the snapshot, then writes `../index.html`. |
| `migrate_to_supabase.py` | One-shot loader that seeded those tables from `legs.csv` and `reference.json`. Idempotent — re-running re-seeds from the files. |
| `viewer/` | The page: shell, stylesheet, app. |
| `../index.html` | Built. Do not edit — `build.py` overwrites it. |

## Switching a journey off

`pack_journey.is_active` takes a journey off the chart and out of the snapshot
without deleting it or its legs, so it can come back without being retyped.
Untick **Runs** in the Edit tab. This replaced a `HIDDEN` list compiled into the
viewer, which needed a deploy to change.

## Who can edit it

Anyone who can open the dashboard. The page holds only the anon key, and these
four tables carry anon policies for every verb — a deliberate decision on
2026-09-03, the same tradeoff already taken for the finance and PO tables.
Adding Supabase auth to the dashboards is the fix whenever it is wanted.

## The chart

Time runs left to right, **the steps run top to bottom, in the order they
happen**. So the chart's rows and the schedule's steps are the same list, every
journey is measured against the same steps, and two threads can be compared by
reading across one row: who reaches Customer first.

A **solid bar is a step being done**, on its own row for as long as it takes;
a **dashed run is the link to the next one**, which is both the waiting and the
descent. There is no key: a bar sits on a row that names it, and the only other
thing on the chart is the line between two of them. The waiting is the point, because it is what nobody can see in a list
of steps.

Each run also gets its own hair's breadth of the lane, fanned about the middle,
so two threads sharing a step are two lines rather than one. The fan narrows as
more threads are shown, because the lane does not grow.

Colour is a **hue per journey and a shade per run of it** — the earlier cut
takes the stronger shade. Ten threads cross each other in a week, and sharing a
hue still says two of them are the same journey.

Where the product physically is rides along on each leg but is not a lane —
it is what has opening hours, and it is in the task list. Faint lines every four
hours give a leg something to be measured against.

## How the chart places labels

Not per-leg tweaks — one rule set, applied to every leg the same way.

**Hours.** A leg's start hour prints to the left of its start dot; its stop hour
prints to the right of its stop dot. One label per moment: a leg's stop is
usually the next one's start, in the same place at the same minute, and that
gets one label, not two on top of each other.

**Names.** Each name tries these anchors in order and takes the first that hits
nothing already placed:

1. centred on the bar, above it
2. centred, below
3. two thirds along, above / below
4. nine tenths along, above / below
5. one third along, above / below

The list is the preference, so a leg with room around it always lands centred on
its own bar and only a crowded one walks down. **Every anchor is a point on the
leg**, so a name can never drift into a lane it does not belong to, however
crowded the chart gets — a label a lane out of place reads as belonging to the
wrong leg, which is worse than a collision.

Add legs, rename places, change times: the placement follows without anything
being positioned by hand.

**Legs are not named on the chart.** A leg's name is the same word on every
journey — Packing, BOL, Drayage — so on a busy week it said nothing while
filling the picture. What is worth saying is which thread this is, and that is
said once, in the thread's own colour: `140 (6h)`, `Off-island (Barge)`. The
leg names are in the task list underneath.

Room for a name is found **along** the thread, not above and below it. Five
journeys leave the same morning, so stacking their names at the start piles
them into a column; walking each one forward to its next step instead spreads
them across the page, and a name still sits on the thread it names.

## The snapshot

`legs.csv` is a snapshot of `pack_journey` and `pack_journey_leg`, rewritten by
every build and committed, so the diff shows what changed and the page still
draws with no network. **Active journeys only** — a journey switched off stays
off, and a fallback that quietly put it back would be the bug `is_active` was
added to fix.

It is written in the grid shape the page has always been able to read: steps
down the side, journeys across the top, a cell saying when that step ran.

```
Crop          Lettuce           Lettuce
FOB           140               Oahu
Mode          Truck             Barge
Hold          6h                6h
Pack/Store 1  Sun 10:00-14:00   Sun 14:00-18:00
```

The day carries over to the stop unless the stop names its own, because most
steps finish on the day they start: `Sun 10:00-14:00`, but `Tue 18:00-Wed 12:00`.

Three rules survive from when this was the live source, and explain shapes you
will meet in the code — the step order is data not layout, where a step runs
between is in `reference.json` rather than per-leg, and branch 2 is generated
rather than stored. They are written up in
[`docs/SHEET-ERA.md`](docs/SHEET-ERA.md).

**A bad row cannot blank the page.** A journey that cannot be built is dropped
and named above the chart rather than taking the other nine with it; if the
database cannot be read at all, the page draws this snapshot and says so.

## Tabs

- **Map** — the chart and the task list for one journey.
- **Orders** — the two pack days as a horizontal bar, then cases on order by
  case type and destination. Day 1 is a 6.5 h shift filled in a fixed order:
  all of Kona's LW, then as much off-island LW as still fits, then all the LF
  and all the trays. Day 2 is the off-island LW that did not fit. Pounds packed
  are shown for each day. The dashed line on the bar is the 6.5 h day, so a bar
  running past it is a day that does not fit. The table's first row is the
  minutes each column needs at the average window.
- **Edit** — the schedule itself: journeys, their legs, the gates and the
  sailings. Fields save when you leave them.
- **Hours** — everybody's clock, whether or not the journey on screen goes
  through them: the farm, Aloha Air's Kona counter, Young Brothers at YB-KWH,
  Honolulu and Kahului, HFA at both ends, Costco Kona receiving and the
  off-island docks — plus the Young Brothers sailing schedule and which boat
  connects to which. Edited in the **Edit** tab; stored in
  `pack_freight_gate` and `pack_sailing`.

Hours **gate** the written times without overriding them: a start or stop
outside its place's hours is printed in red in the task list and named above it.

## Not here

Turning rows into journeys happens once, in `viewer/app.js`, because the page
does it at load time. `build.py` does not do it again in Python; two copies of
those rules would drift. The database reader and the snapshot reader share
`expand` and `stepIndex` for the same reason.

Honolulu to Nawiliwili: departs Monday and Thursday, arrives Tuesday and
Friday. The Kauai leg is not modelled by any journey yet.

The page has no login. See **Who can edit it** above.

> Until 2026-09-03 this section said *"This is a viewer. Editing a journey
> means editing the sheet. Interactive editing was tried and taken back out —
> the builder was becoming the product."* That held while Google Sheets was the
> editing surface. Moving the schedule into Postgres removed the thing it was
> weighing against, and the Edit tab was built.

## Where this lives

Source for the Logistics tab of the dash, at `dash/logistics/src`. `python3
build.py` writes the published page directly to `dash/logistics/index.html` —
the file the hub iframes — so there is no copy step.

History before 2026-09-03 is in `lfeder/farm-logistics-map`, which still
exists on GitHub and is no longer built from.
