/* =============================================================
   functions/api/subscribe.js  —  Cloudflare Pages Function
   /women form POST -> Keap (create/update contact + tags + fields)

   WE, WOMEN OF LIGHT (WWOL).
   Adapted from the shipped New Masculine Emerging Function. Same
   architecture; WWOL tag IDs, WWOL custom fields, WWOL band ranges.

   Contract (set by the /women page — do not change):
     IN : { firstName, lastName, email, consent, company(honeypot),
            page, utm_*,  score?, archetype? }
     OUT: { ok:true } | { ok:false, error:"message" }

     score/archetype present => quiz submit: apply LEAD + QUIZ +
     the matching archetype band tag, and write the WWOL custom
     fields. Absent => skip submit: apply LEAD + SKIP only.

   Setup: Cloudflare env var KEAP_SAK = Keap Service Account Key.
          Must be set on the WWOL Pages project, Production AND
          Preview. Env vars do NOT carry over between projects —
          setting it on NME does nothing here.
   Auth : Authorization: Bearer <SAK>.
   ============================================================= */

const KEAP_BASE = "https://api.infusionsoft.com/crm/rest/v1";

/* ═══════════════════════════════════════════════════════════════
   CONFIGURE ME — everything WWOL-specific lives in this block.
   Nothing below it needs to change.

   All five tag IDs are null until the tags exist in Keap. A null
   tag is silently skipped, so this file is SAFE TO DEPLOY NOW:
   contacts are created and custom fields are written, only the
   tagging is deferred. Fill the numbers in and redeploy.

   DO NOT reuse NME's tag IDs (350/326/352/342/344/346/348). The
   NME nurture sequences trigger off those; a WWOL signup carrying
   them would be dropped into the men's campaign.
   ═══════════════════════════════════════════════════════════════ */

const LEAD_TAG = null;   // WWOL-Lead            — every capture, both paths
const QUIZ_TAG = null;   // WWOL-Quiz-Complete   — quiz submits only
const SKIP_TAG = null;   // WWOL-Skip            — skip submits only

/* IMPORTANT (see the KEAP rules): LEAD_TAG is a marker, not a trigger.
   Nothing should be triggered on WWOL-Lead. The two nurture sequences
   trigger on QUIZ_TAG and SKIP_TAG respectively, so no campaign ever
   needs a decision diamond to tell the two paths apart. All three tags
   land in the SAME API call, so exclusion logic on them would race. */

/* Archetype tags — quiz submits ONLY, one per score band, so the
   nurture sequence can branch by archetype later without a code change.
   Ranges are WWOL's (14 questions, 14-56) and differ from NME's
   (10 questions, 10-40) — do not copy across. */
const BAND_TAGS = [
  { min: 14, max: 24, name: "The Veiled Woman",    tag: null },  // WWOL-Type-Veiled
  { min: 25, max: 35, name: "The Awakening Woman", tag: null },  // WWOL-Type-Awakening
  { min: 36, max: 46, name: "The Rising Woman",    tag: null },  // WWOL-Type-Rising
  { min: 47, max: 56, name: "The Luminous Woman",  tag: null }   // WWOL-Type-Luminous
];

/* Custom fields, resolved by database name / label (normalized).
   Create these in Keap as type Text, labelled "WWOL - Quiz Score"
   and "WWOL - Female Archetype". norm() strips non-alphanumerics,
   so either the label or the database name will match. */
const CF_TARGETS = { score: "wwolquizscore", archetype: "wwolfemalearchetype" };

/* ═══════════════ end of configuration ═══════════════ */

/* module-scope cache of resolved custom-field IDs (best-effort across
   invocations on the same isolate; re-resolves if missing) */
let CF_CACHE = null;

/* Band lookup from the NUMERIC score (server-side, so a mangled or
   spoofed archetype string can never mis-tag a contact). */
function bandForScore(n) {
  if (!Number.isFinite(n)) return null;
  for (const b of BAND_TAGS) { if (n >= b.min && n <= b.max) return b; }
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function norm(s) { return String(s == null ? "" : s).replace(/[^a-z0-9]/gi, "").toLowerCase(); }

/* Resolve {score, archetype} custom-field IDs from the contact model.
   Matches on field_name OR label (both normalize to the same token,
   e.g. "WWOL - Quiz Score" and "WWOLQuizScore" -> "wwolquizscore"). */
async function resolveCustomFieldIds(headers) {
  if (CF_CACHE && CF_CACHE.score && CF_CACHE.archetype) return CF_CACHE;
  try {
    const res = await fetch(`${KEAP_BASE}/contacts/model`, { headers });
    if (!res.ok) { console.error("subscribe: model fetch failed", res.status); return {}; }
    const model = await res.json();
    const fields = (model && model.custom_fields) || [];
    const out = {};
    for (const f of fields) {
      const keys = [norm(f.field_name), norm(f.label)];
      if (keys.indexOf(CF_TARGETS.score)     !== -1) out.score     = f.id;
      if (keys.indexOf(CF_TARGETS.archetype) !== -1) out.archetype = f.id;
    }
    /* Loud on first run so a rename in Keap surfaces immediately
       instead of silently dropping the merge fields. */
    console.log("subscribe: custom field resolution ->", JSON.stringify(out));
    if (!out.score || !out.archetype) {
      console.error("subscribe: UNRESOLVED custom field(s). Looking for",
        JSON.stringify(CF_TARGETS), "| available:",
        JSON.stringify(fields.map(f => ({ id: f.id, name: f.field_name, label: f.label }))));
    }
    if (out.score && out.archetype) CF_CACHE = out;
    return out;
  } catch (e) {
    console.error("subscribe: model lookup error", e && e.message);
    return {};
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try { data = await request.json(); }
  catch { return json({ ok: false, error: "Bad request." }, 400); }

  // Honeypot: bots fill 'company'. Silently succeed, create nothing.
  if (data.company && String(data.company).trim() !== "") {
    return json({ ok: true });
  }

  const firstName = (data.firstName || "").trim();
  const lastName  = (data.lastName  || "").trim();
  const email     = (data.email     || "").trim();
  const emailOk   = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  if (!firstName || !lastName || !emailOk) {
    return json({ ok: false, error: "Please complete all fields with a valid email." }, 422);
  }
  if (data.consent !== true && data.consent !== "yes") {
    return json({ ok: false, error: "Please check the box to subscribe." }, 422);
  }

  // Quiz submit? (score present)
  const isQuiz = data.score !== undefined && data.score !== null && String(data.score).trim() !== "";
  const scoreStr  = isQuiz ? String(data.score).trim() : "";
  const archetype = isQuiz ? String(data.archetype || "").trim() : "";

  // Null tags are dropped, so this works before the tags exist in Keap.
  const tagIds = (isQuiz ? [LEAD_TAG, QUIZ_TAG] : [LEAD_TAG, SKIP_TAG]).filter(t => t != null);

  // Archetype tag (quiz only, derived server-side from the numeric score).
  if (isQuiz) {
    const band = bandForScore(parseInt(scoreStr, 10));
    if (band && band.tag) tagIds.push(band.tag);
    else if (band && !band.tag) console.log("subscribe: archetype tag not configured for band", band.name);
    else console.error("subscribe: score out of range, no archetype tag", scoreStr);
  }

  const SAK = env.KEAP_SAK;
  if (!SAK) {
    console.error("subscribe: KEAP_SAK env var is missing");
    return json({ ok: false, error: "Subscription service is not configured yet." }, 500);
  }

  const headers = {
    "Authorization": "Bearer " + SAK,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };

  try {
    // Build the custom_fields array for quiz submits (best-effort).
    let customFields = [];
    if (isQuiz) {
      const ids = await resolveCustomFieldIds(headers);
      if (ids.score)     customFields.push({ id: ids.score,     content: scoreStr });
      if (ids.archetype) customFields.push({ id: ids.archetype, content: archetype });
    }

    /* 1) Create or update by email. Keap wants duplicate_option in the BODY.
          Custom fields go in THIS call — confirmed to stick, no follow-up
          PATCH needed — so merge fields are populated before the tag fires
          the campaign in step 2. Order matters; do not reverse. */
    const body = {
      duplicate_option: "Email",
      given_name: firstName,
      family_name: lastName,
      email_addresses: [{ email, field: "EMAIL1" }]
    };
    if (customFields.length) body.custom_fields = customFields;

    const upsert = await fetch(`${KEAP_BASE}/contacts`, {
      method: "PUT", headers, body: JSON.stringify(body)
    });

    if (!upsert.ok) {
      console.error("subscribe: Keap contact upsert failed", upsert.status, await upsert.text());
      return json({ ok: false, error: "We couldn't save your details. Please try again." }, 502);
    }

    const contact = await upsert.json();
    const contactId = contact && contact.id;
    if (!contactId) {
      console.error("subscribe: no contact id returned", JSON.stringify(contact).slice(0, 500));
      return json({ ok: false, error: "We couldn't save your details. Please try again." }, 502);
    }

    // 2) Apply tags. Skipped entirely while every tag is still null.
    if (tagIds.length) {
      const tagRes = await fetch(`${KEAP_BASE}/contacts/${contactId}/tags`, {
        method: "POST", headers, body: JSON.stringify({ tagIds })
      });

      if (!tagRes.ok) {
        console.error("subscribe: Keap tag apply failed", tagRes.status, await tagRes.text(), "contactId=" + contactId);
        return json({ ok: true, warning: "tagging_failed" });
      }
    } else {
      console.log("subscribe: no tags configured yet, contact created untagged", "contactId=" + contactId);
    }

    return json({ ok: true });

  } catch (e) {
    console.error("subscribe: unexpected error", e && e.message);
    return json({ ok: false, error: "We couldn't reach the subscription service. Please try again." }, 502);
  }
}
