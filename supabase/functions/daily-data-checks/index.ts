// Nightly data-quality checks for the Daily dashboard.
// Runs at 5pm HST (03:00 UTC) via pg_cron, evaluates each active rule in
// data_check_rule against the live sheet data, upserts results to
// data_check_result, refreshes the harvest-photo gallery, and (optionally)
// emails a summary with a dashboard link.
//
// Mirrors the dashboard's client-side check engine. Sheet/column specifics live
// in CROP below — keep in sync with lib/data-source.js if the sheets change.

const SUPABASE_URL = Deno.env.get("CHECK_SUPABASE_URL")!; // prod REST base
const SERVICE_KEY  = Deno.env.get("CHECK_SERVICE_KEY")!;  // prod service_role
const RESEND_KEY   = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_TO     = (Deno.env.get("CHECK_EMAIL_TO") ?? "").split(",").map(s => s.trim()).filter(Boolean);
const EMAIL_FROM   = Deno.env.get("CHECK_EMAIL_FROM") ?? "Farm Dash <onboarding@resend.dev>";
const DASH_URL     = "https://lfeder.github.io/farm-dash/?src=sheets#daily";

const FS   = "1MbHJoJmq0w8hWz8rl9VXezmK-63MFmuK19lz3pu0dfc";
const GROW = "1VtEecYn-W1pbnIU1hRHfxIpkH2DtK7hj0CpcpiLoziM";

// The most photos kept for one group. A mixed-board day runs ~8; the cap only
// guards against a bulk backfill landing on a single date. There is no lookback
// window any more — the refresh asks about one day, today's.
const GALLERY_MAX_PHOTOS  = 24;

// Per crop (rule.harvest_key): how to read the pre-op and the harvest from sheets.
const CROP: Record<string, any> = {
  cuke: {
    preop:   { sheet: FS,   tab: "fsafe_log_C_gh_pre", dateCol: "A", flagCol: "I", membersCol: "B", sep: "+" },
    harvest: { sheet: GROW, tab: "grow_C_harvest",     dateCol: "A", dimCol: "G", where: "and B=2026" },
  },
  lettuce: {
    preop:   { sheet: FS,   tab: "fsafe_log_L_gh_pre", dateCol: "A", flagCol: "S" },
    harvest: { sheet: GROW, tab: "grow_L_seeding",     dateCol: "N", dimCol: "B", where: "" },
  },
};

function hstToday(): string {
  const d = new Date(Date.now() - 10 * 3600 * 1000); // HST = UTC-10
  return d.toISOString().slice(0, 10);
}

function daysBefore(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Minimal gviz CSV reader. Our SELECTed columns never contain commas, so a
// split on '","' (after trimming the outer quotes) is sufficient.
async function gviz(sheet: string, tab: string, query: string): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${sheet}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}&tq=${encodeURIComponent(query)}`;
  const text = await (await fetch(url)).text();
  return text.trim().split("\n").filter(Boolean).map(l => l.replace(/^"|"$/g, "").split('","'));
}

async function evaluateRule(rule: any, date: string) {
  const cfg = CROP[rule.harvest_key];
  if (!cfg) return null;
  const p = cfg.preop;
  const cols = p.membersCol ? `${p.dateCol},${p.membersCol},${p.flagCol}` : `${p.dateCol},${p.flagCol}`;
  const preop = (await gviz(p.sheet, p.tab, `select ${cols} where ${p.dateCol} = date '${date}'`)).slice(1);
  const flagIdx = p.membersCol ? 2 : 1;
  const approved = preop.filter(r => (r[flagIdx] || "").toUpperCase() === "TRUE");
  if (!approved.length) return null; // not a harvest day -> no expectation

  let expected = 0;
  if (String(rule.expected).toLowerCase() === "preop") {
    const set = new Set<string>();
    approved.forEach(r => (r[1] || "").split(p.sep || "+").map((s: string) => s.trim()).filter(Boolean).forEach((m: string) => set.add(m)));
    expected = set.size;
  } else {
    expected = Number(rule.expected) || 0;
  }
  if (!expected) return null;

  const h = cfg.harvest;
  const harvest = await gviz(h.sheet, h.tab, `select ${h.dimCol}, count(${h.dimCol}) where ${h.dateCol} = date '${date}' ${h.where} group by ${h.dimCol}`);
  const actual = Math.max(0, harvest.length - 1);
  const passed = actual >= expected;
  const detail = passed ? null : String(rule.message || rule.name).replace("{actual}", String(actual)).replace("{expected}", String(expected));
  return { rule_id: rule.id, checked_date: date, passed, detail, run_at: new Date().toISOString() };
}

function restHeaders(extra: Record<string, string> = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...extra };
}

async function restGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: restHeaders() });
  return await r.json();
}

// ── Harvest-photo gallery ───────────────────────────────────────────────────
// The dashboard runs as anon and grow_lettuce_seed_batch is authenticated-only,
// so the page cannot read final_photo_path itself. Here — service key, minutes
// before the email — we snapshot the newest photo day per crop group into
// dash_crop_photo, which the page can read.
//
// Per group, for the report's own day and no other: the tile answers "what
// happened to this crop today", so it is rewritten every run and never carries
// a date other than today's.
//
//   ok             harvested today, and photographed
//   photo_missing  harvested today, nobody photographed it
//   no_harvest     not harvested today
//
// The old rule kept the previous day's photos when none arrived, which made a
// stale tile look current — on 2026-08-24 Reds showed the 17th while reds had
// been cut that morning. Silence now says which kind of silence it is.
// Stable, human-readable photo label: lane + seeding date (e.g. "P3A 08/18").
// Replaces the old batch_code string, which encoded the same facts plus stale
// harvest dates and board counts.
function photoLabel(b: any): string {
  const lane = b.lane || "?";
  const sd = String(b.seeding_date || "");
  const md = sd.length >= 10 ? `${sd.slice(5, 7)}/${sd.slice(8, 10)}` : sd;
  return md ? `${lane} ${md}` : lane;
}

async function refreshGallery(today: string) {
  const groups = await restGet("dash_crop_group?is_active=eq.true&select=*&order=sort_order");
  if (!Array.isArray(groups) || !groups.length) return [];

  const [batches, items] = await Promise.all([
    // lane + seeding_date replace batch_code here: batch_code is being retired
    // from grow_lettuce_seed_batch (lane and variety now live in their own
    // columns). dash_crop_photo.batch_code stays as the photo caption, but is
    // now filled with a lane/seeding label rather than the old lineage string.
    // Deliberately NOT filtered to rows carrying a photo: a batch harvested
    // today without one is the whole point of photo_missing, and filtering it
    // out here would make it indistinguishable from no_harvest.
    restGet("grow_lettuce_seed_batch?select=harvest_date,lane,seeding_date,invnt_item_id," +
            "grow_lettuce_seed_mix_id,final_photo_path" +
            "&is_deleted=eq.false&org_id=eq.hawaii_farming" +
            `&harvest_date=eq.${today}&limit=4000`),
    restGet("invnt_item?select=id,grow_variety_id&grow_variety_id=not.is.null&limit=10000"),
  ]);
  if (!Array.isArray(batches) || !Array.isArray(items)) {
    console.error("gallery: unexpected REST payload", JSON.stringify({ batches, items }).slice(0, 300));
    return [];
  }

  const varietyOf = new Map<string, string>(items.map((i: any) => [i.id, i.grow_variety_id]));
  const summary: any[] = [];
  for (const g of groups) {
    const varieties: string[] = g.variety_ids || [];
    // A mixed-board batch carries a seed mix and no seed item, so it is claimed
    // by the mix flag rather than by a variety code.
    const mine = batches.filter((b: any) =>
      (g.match_seed_mix && b.grow_lettuce_seed_mix_id) ||
      varieties.includes(varietyOf.get(b.invnt_item_id) || ""));

    const shot = mine.filter((b: any) => b.final_photo_path);
    const status = !mine.length ? "no_harvest" : (shot.length ? "ok" : "photo_missing");
    const stamp = new Date().toISOString();

    // One placeholder row for the two photo-less states, so the group is still
    // present in the view and the page has a date and a reason to show.
    const rows = status === "ok"
      ? shot
          .sort((a: any, b: any) => photoLabel(a).localeCompare(photoLabel(b)))
          .slice(0, GALLERY_MAX_PHOTOS)
          .map((b: any, seq: number) => ({
            group_id: g.id, status: "ok",
            photo_path: b.final_photo_path,
            gallery_date: today,
            batch_code: photoLabel(b),
            cultivar: b.invnt_item_id || b.grow_lettuce_seed_mix_id,
            seq,
            refreshed_at: stamp,
          }))
      : [{ group_id: g.id, status, photo_path: null, gallery_date: today,
           batch_code: null, cultivar: null, seq: 0, refreshed_at: stamp }];

    // Replace rather than upsert: the snapshot holds exactly one day per group,
    // and a group that had eight photos yesterday and none today must end up
    // with the single photo_missing row, not eight stale ones beside it.
    const del = await fetch(`${SUPABASE_URL}/rest/v1/dash_crop_photo?group_id=eq.${encodeURIComponent(g.id)}`,
      { method: "DELETE", headers: restHeaders() });
    if (!del.ok) { console.error("gallery delete failed", g.id, await del.text()); continue; }

    const ins = await fetch(`${SUPABASE_URL}/rest/v1/dash_crop_photo`, {
      method: "POST",
      headers: restHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(rows),
    });
    if (!ins.ok) { console.error("gallery insert failed", g.id, await ins.text()); continue; }

    summary.push({ group_id: g.id, label: g.label, date: today, status,
                   photos: status === "ok" ? rows.length : 0, updated: true });
  }
  return summary;
}

Deno.serve(async () => {
  const date = hstToday();
  const rules = await restGet("data_check_rule?is_active=eq.true&select=*");
  const results = [];
  for (const rule of rules) {
    try {
      const res = await evaluateRule(rule, date);
      if (res) results.push(res);
    } catch (e) { console.error("rule", rule.id, e); }
  }

  if (results.length) {
    await fetch(`${SUPABASE_URL}/rest/v1/data_check_result?on_conflict=rule_id,checked_date`, {
      method: "POST",
      headers: restHeaders({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }),
      body: JSON.stringify(results),
    });
  }

  // Pull the photos before the email goes out, so the dashboard it links to is
  // already showing the new set. A gallery failure must not cost us the checks
  // email, hence the catch.
  let gallery: any[] = [];
  try {
    gallery = await refreshGallery(date);
  } catch (e) { console.error("refreshGallery error", e); }

  const fails = results.filter(r => !r.passed);
  let emailed = false;
  if (RESEND_KEY && EMAIL_TO.length) {
    const body = fails.length
      ? fails.map(f => `⚠ ${f.detail}`).join("<br>")
      : "All data checks passed.";
    const updated = gallery.filter(g => g.updated);
    const photoLine = updated.length
      ? `<p>New harvest photos: ${updated.map(g => `${g.label} ${g.date} (${g.photos})`).join(" · ")}</p>`
      : "";
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM, to: EMAIL_TO,
        subject: `Daily — ${fails.length} data issue${fails.length === 1 ? "" : "s"} (${date})`,
        html: `<p>${body}</p>${photoLine}<p><a href="${DASH_URL}">Open the Daily dashboard</a></p>`,
      }),
    });
    emailed = resp.ok;
    if (!resp.ok) console.error("resend error", await resp.text());
  }

  return new Response(JSON.stringify({ date, results, fails: fails.length, emailed, gallery }), {
    headers: { "Content-Type": "application/json" },
  });
});
