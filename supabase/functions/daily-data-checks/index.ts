// Nightly data-quality checks for the Daily dashboard.
// Runs at 5pm HST (03:00 UTC) via pg_cron, evaluates each active rule in
// data_check_rule against the live sheet data, upserts results to
// data_check_result and (optionally) emails a summary with a dashboard link.
//
// Two kinds of rule. min_distinct_count reads a pre-op sheet for what was
// expected and counts what the harvest sheet recorded. photo_logged asks
// dash_crop_harvest_v whether a crop was cut that day and whether a photo came
// with it — same question the dashboard tile answers, asked here so it reaches
// the mail rather than waiting to be noticed.
//
// Every source is Supabase; Google Sheets was switched off 2026-08-09.

const SUPABASE_URL = Deno.env.get("CHECK_SUPABASE_URL")!; // prod REST base
const SERVICE_KEY  = Deno.env.get("CHECK_SERVICE_KEY")!;  // prod service_role
const RESEND_KEY   = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_TO     = (Deno.env.get("CHECK_EMAIL_TO") ?? "").split(",").map(s => s.trim()).filter(Boolean);
const EMAIL_FROM   = Deno.env.get("CHECK_EMAIL_FROM") ?? "Farm Dash <onboarding@resend.dev>";
const DASH_URL     = "https://lfeder.github.io/farm-dash/#daily";



function hstToday(): string {
  const d = new Date(Date.now() - 10 * 3600 * 1000); // HST = UTC-10
  return d.toISOString().slice(0, 10);
}



// "Harvested but nobody photographed it" — the same question the dashboard tile
// answers, asked here so it reaches the 5pm mail instead of waiting for someone
// to open the page. No pre-op and no expected count: the harvest view already
// knows what was cut, and a photo either came with it or did not.
//
// Not harvested that day returns null, exactly as a non-harvest day does for
// the sheet checks — silence, not a pass and not a failure.
async function evaluatePhotoRule(rule: any, date: string) {
  const gid = encodeURIComponent(rule.dimension || "");
  const rows = await restGet(
    `dash_crop_harvest_v?select=photo_path&group_id=eq.${gid}&harvest_date=eq.${date}`);
  if (!Array.isArray(rows) || !rows.length) return null;

  const shot = rows.filter((r: any) => r.photo_path).length;
  const passed = shot > 0;
  const detail = passed ? null
    : String(rule.message || rule.name)
        .replace("{actual}", String(shot))
        .replace("{expected}", String(rows.length));
  return { rule_id: rule.id, checked_date: date, passed, detail,
           run_at: new Date().toISOString() };
}

// Only photo_logged rules run here now. The two min_distinct_count rules read
// Google Sheets, which stopped being written on 2026-08-09, and were suspended
// on 2026-08-25 — an empty pre-op read as "not a harvest day", so they wrote no
// result, counted no failure, and the mail reported an all-clear nobody earned.
// Their evaluator and its gviz reader are deleted rather than left to look like
// working checks. Reinstate against prod when the rules are ported.
async function evaluateRule(rule: any, date: string) {
  if (rule.check_type === "photo_logged") return await evaluatePhotoRule(rule, date);
  console.warn("no evaluator for check_type", rule.check_type, "- rule", rule.id);
  return null;
}

function restHeaders(extra: Record<string, string> = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...extra };
}

async function restGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: restHeaders() });
  return await r.json();
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

  const fails = results.filter(r => !r.passed);
  let emailed = false;
  if (RESEND_KEY && EMAIL_TO.length) {
    const body = fails.length
      ? fails.map(f => `⚠ ${f.detail}`).join("<br>")
      : "All data checks passed.";
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM, to: EMAIL_TO,
        subject: `Daily — ${fails.length} data issue${fails.length === 1 ? "" : "s"} (${date})`,
        html: `<p>${body}</p><p><a href="${DASH_URL}">Open the Daily dashboard</a></p>`,
      }),
    });
    emailed = resp.ok;
    if (!resp.ok) console.error("resend error", await resp.text());
  }

  return new Response(JSON.stringify({ date, results, fails: fails.length, emailed }), {
    headers: { "Content-Type": "application/json" },
  });
});
