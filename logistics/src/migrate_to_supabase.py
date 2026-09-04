"""One-shot: load legs.csv and reference.json into the pack_ logistics tables.

    python3 migrate_to_supabase.py          # print the SQL, change nothing
    python3 migrate_to_supabase.py --apply  # run it against prod

Committed rather than run from a scratchpad so the migration can be read back
and repeated. It is idempotent -- every journey, gate and sailing is deleted
and rewritten -- so re-running it re-seeds the tables from the files, which is
also how you would roll back a bad edit made in the tab.

Reads the SNAPSHOT (legs.csv), not the sheet, so what lands in Postgres is the
schedule that was committed and reviewed, not whatever the sheet said at the
moment somebody ran this.
"""
import csv
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROD = "zdvpqygiqavwpxljpvqw"
DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
DAY_WORDS = {"su": 0, "sun": 0, "sunday": 0, "m": 1, "mo": 1, "mon": 1, "monday": 1,
             "t": 2, "tu": 2, "tue": 2, "tues": 2, "tuesday": 2,
             "w": 3, "we": 3, "wed": 3, "wednesday": 3,
             "th": 4, "thu": 4, "thur": 4, "thurs": 4, "thursday": 4,
             "f": 5, "fr": 5, "fri": 5, "friday": 5,
             "sa": 6, "sat": 6, "saturday": 6}
# The identity block at the top of each column, keyed as the viewer keys it.
HEAD_KEYS = {"crop": "crop", "fob": "fob", "transport": "transport",
             "mode": "transport", "hold": "hold",
             "start day": "start_days", "start_day": "start_days"}

# Journeys that are in the sheet but that we do not run. Until now this was a
# HIDDEN list compiled into the viewer, so hiding one took a deploy; it becomes
# is_active here, which is the whole point of the move.
INACTIVE = [{"crop": "lettuce", "fob": "140", "hold": "48h"},
            {"crop": "lettuce", "fob": "oahu", "transport": "air"}]

REF = json.load(open(os.path.join(HERE, "reference.json")))


def q(v):
    """A SQL literal. None becomes NULL; everything else is a quoted string."""
    if v is None or v == "":
        return "null"
    return "'" + str(v).replace("'", "''") + "'"


def daytime(spec, where):
    """'Sun 10:00' -> (0, '10:00'). The day is a word; the time is 24h."""
    m = re.match(r"^([A-Za-z]+)\s*,?\s*(\d{1,2}):(\d{2})$", spec.strip())
    if not m:
        sys.exit("%s: expected a day and a time like 'Sun 10:00', got %r" % (where, spec))
    d = DAY_WORDS.get(m.group(1).strip().lower())
    if d is None:
        sys.exit("%s: %r is not a day" % (where, m.group(1)))
    h, mn = int(m.group(2)), int(m.group(3))
    if h > 23 or mn > 59:
        sys.exit("%s: %r is not a time" % (where, m.group(0)))
    return d, "%02d:%02d" % (h, mn)


def span(cell, where):
    """'Sun 10:00-14:00' or 'Tue 18:00-Wed 12:00'.

    The day carries over to the stop unless the stop names one of its own,
    because most steps finish on the day they start and saying so twice is
    noise. Same rule the viewer reads the sheet by.
    """
    t = re.sub(r"[\s  ]+", " ", str(cell)).strip()
    m = re.match(r"^([A-Za-z]+ ?,? ?\d{1,2}:\d{2})\s*[-–]\s*(.+)$", t)
    if not m:
        sys.exit("%s: expected 'Sun 10:00-14:00', got %r" % (where, t))
    sd, st = daytime(m.group(1), where)
    tail = m.group(2).strip()
    if re.match(r"^\d{1,2}:\d{2}$", tail):
        ed, et = daytime(DOW[sd] + " " + tail, where)
    else:
        ed, et = daytime(tail, where)
    return sd, st, ed, et


def slug(s):
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", s.lower()))


def inactive(head):
    for want in INACTIVE:
        if all((head.get(k) or "").strip().lower() == v for k, v in want.items()):
            return True
    return False


# ── read the grid ───────────────────────────────────────────────────────────
# One journey per column: an identity block at the top, then a cell per step.
# A label is part of the identity until the first step is seen; after that it
# is a step, because Transport is both a thing a journey IS and a step it takes.
rows = list(csv.reader(open(os.path.join(HERE, "legs.csv"))))
steps = [s["step"] for s in REF["steps"]["order"]]
by_step = {}
for s in REF["steps"]["order"]:
    by_step[s["step"].lower()] = s["step"]
    for old in s.get("was") or []:
        by_step[old.lower()] = s["step"]

lab = next((i for i, r in enumerate(rows)
            if r and r[0].strip().lower() == "crop"), None)
if lab is None:
    sys.exit("legs.csv: no row labelled Crop")
wide = max(len(r) for r in rows)

journeys, legs = [], []
for j in range(1, wide):
    head, cells, started = {}, [], False
    for r in rows[lab:]:
        name = (r[0] if r else "").strip()
        cell = (r[j] if j < len(r) else "").strip()
        if not name:
            continue
        key = name.lower()
        if not started and key in HEAD_KEYS:
            head[HEAD_KEYS[key]] = cell
            continue
        if key not in by_step:
            continue
        started = True
        if cell:
            cells.append((by_step[key], cell))
    if not (head.get("crop") or head.get("fob")) or not cells:
        continue

    name = "-".join(x for x in [head.get("crop"), head.get("fob"),
                                head.get("transport"), head.get("hold")] if x)
    jid = slug(name)
    journeys.append({
        "id": jid, "crop": head.get("crop"), "fob": head.get("fob"),
        "transport": head.get("transport") or None, "hold": head.get("hold") or None,
        "start_days": head.get("start_days") or str(REF.get("start_days") or "0"),
        "is_active": not inactive(head), "display_order": j})
    for step, cell in cells:
        sd, st, ed, et = span(cell, "%s / %s" % (name, step))
        legs.append({"pack_journey_id": jid, "step": step,
                     "step_order": steps.index(step), "start_dow": sd,
                     "start_time": st, "end_dow": ed, "end_time": et})

# ── the SQL ─────────────────────────────────────────────────────────────────
out = ["begin;",
       "delete from public.pack_journey_leg;",
       "delete from public.pack_journey;",
       "delete from public.pack_freight_gate;",
       "delete from public.pack_sailing;"]

for j in journeys:
    out.append(
        "insert into public.pack_journey "
        "(id, crop, fob, transport, hold, start_days, is_active, display_order) values "
        "(%s, %s, %s, %s, %s, %s, %s, %d);" % (
            q(j["id"]), q(j["crop"]), q(j["fob"]), q(j["transport"]), q(j["hold"]),
            q(j["start_days"]), "true" if j["is_active"] else "false", j["display_order"]))

for g in legs:
    out.append(
        "insert into public.pack_journey_leg "
        "(pack_journey_id, step, step_order, start_dow, start_time, end_dow, end_time) "
        "values (%s, %s, %d, %d, %s, %d, %s);" % (
            q(g["pack_journey_id"]), q(g["step"]), g["step_order"],
            g["start_dow"], q(g["start_time"]), g["end_dow"], q(g["end_time"])))

for n, h in enumerate(REF.get("hours", [])):
    if not (h.get("place") or "").strip():
        continue
    out.append(
        "insert into public.pack_freight_gate "
        "(id, days, open_time, close_time, display_order, notes) values "
        "(%s, %s, %s, %s, %d, %s);" % (
            q(h["place"].strip()), q(h.get("days")), q(h.get("open")),
            q(h.get("close")), n, q(h.get("note"))))

for n, s in enumerate(REF.get("sailings", [])):
    if not (s.get("route") or "").strip():
        continue
    out.append(
        "insert into public.pack_sailing "
        "(route, departs, arrives, connects, display_order, notes) values "
        "(%s, %s, %s, %s, %d, %s);" % (
            q(s["route"].strip()), q(s.get("departs")), q(s.get("arrives")),
            q(s.get("connects")), n, q(s.get("note"))))

out.append("commit;")
sql = "\n".join(out)

hidden = [j["id"] for j in journeys if not j["is_active"]]
print("%d journeys (%d inactive: %s), %d legs, %d gates, %d sailings" % (
    len(journeys), len(hidden), ", ".join(hidden) or "none", len(legs),
    sum(1 for h in REF.get("hours", []) if (h.get("place") or "").strip()),
    sum(1 for s in REF.get("sailings", []) if (s.get("route") or "").strip())),
    file=sys.stderr)

if "--apply" not in sys.argv:
    print(sql)
    print("\n-- dry run. Pass --apply to send this to prod.", file=sys.stderr)
    sys.exit(0)

req = urllib.request.Request(
    "https://api.supabase.com/v1/projects/%s/database/query" % PROD,
    data=json.dumps({"query": sql}).encode(),
    headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
             "Content-Type": "application/json",
             # Cloudflare 1010s the default Python-urllib agent.
             "User-Agent": "curl/8.7.1"})
with urllib.request.urlopen(req, timeout=90) as fh:
    fh.read()
print("applied to prod", file=sys.stderr)
