import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/* ── Sakari helpers ───────────────────────────────────────────────── */
async function getSakariToken(): Promise<string> {
  const res = await fetch("https://api.sakari.io/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type:    "client_credentials",
      client_id:     Deno.env.get("SAKARI_CLIENT_ID")!,
      client_secret: Deno.env.get("SAKARI_CLIENT_SECRET")!,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Sakari auth failed: " + JSON.stringify(data));
  return data.access_token;
}

async function sendSMS(toNumber: string, body: string): Promise<void> {
  const token     = await getSakariToken();
  const accountId = Deno.env.get("SAKARI_ACCOUNT_ID")!;
  const res = await fetch(`https://api.sakari.io/v1/accounts/${accountId}/messages`, {
    method: "POST",
    headers: { "Authorization": `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ contacts: [{ mobile: { number: toNumber } }], template: body }),
  });
  const result = await res.json();
  if (!res.ok) console.error("SMS error:", JSON.stringify(result));
  else console.log("SMS sent to", toNumber);
}

function toE164(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return d.length >= 7 ? "+" + d : null;
}

/* ── Main handler ─────────────────────────────────────────────────── */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const body = await req.json();
    const {
      first_name    = "",
      last_name     = "",
      email         = "",
      phone         = "",
      accredited    = "",
      invest_amount = "",
      timeframe     = "",
      message       = "",
      notes         = "",
      sms_consent   = false,
      source_page   = "",
      deal_name     = "",
      heard_from    = "",
      country       = "",
      webinar_date  = null,
    } = body;

    // ── 1. Save to Supabase ──────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const insertData: Record<string, unknown> = {
      first_name, last_name, email, phone,
      accredited, invest_amount, timeframe,
      message: message || notes,
      sms_consent: Boolean(sms_consent),
      source_page, heard_from, country,
    };
    if (webinar_date) insertData.webinar_date = webinar_date;

    const { data: lead, error: dbError } = await supabase
      .from("leads")
      .insert(insertData)
      .select()
      .single();

    if (dbError) console.error("DB error:", dbError);

    // ── 2. Money Week confirmation SMS ───────────────────────────────
    const isMW = deal_name === "XSITE Money Week" || source_page === "Money Week";
    if (isMW && phone) {
      const e164 = toE164(phone);
      if (e164) {
        try {
          const msg = `Hi ${first_name}! You're registered for XSITE Money Week — 3 live sessions on taxes, self-directed IRAs & asset protection. Check your email for Zoom links before each session. Reply STOP to opt out.`;
          await sendSMS(e164, msg);
          if (lead?.id) await supabase.from("leads").update({ sms_confirmed: true }).eq("id", lead.id);
        } catch (e) { console.error("Money Week SMS error:", e); }
      }
    }

    // ── 3. Pipedrive ─────────────────────────────────────────────────
    const PD_KEY      = Deno.env.get("PIPEDRIVE_API_KEY");
    const PD_PIPELINE = Deno.env.get("PIPEDRIVE_PIPELINE_ID") ?? "4";
    const PD_STAGE    = Deno.env.get("PIPEDRIVE_STAGE_ID") ?? "28";
    const PD_BASE     = "https://api.pipedrive.com/v1";

    if (!PD_KEY) throw new Error("PIPEDRIVE_API_KEY not set");

    // Find or create person
    const searchRes  = await fetch(`${PD_BASE}/persons/search?term=${encodeURIComponent(email)}&fields=email&api_token=${PD_KEY}`);
    const searchData = await searchRes.json();
    let personId: number | null = null;

    if (searchData?.data?.items?.length > 0) {
      personId = searchData.data.items[0].item.id;
    } else {
      const cp = await fetch(`${PD_BASE}/persons?api_token=${PD_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:  `${first_name} ${last_name}`.trim(),
          email: [{ value: email, primary: true }],
          phone: phone ? [{ value: phone, primary: true }] : undefined,
        }),
      });
      personId = (await cp.json())?.data?.id ?? null;
    }

    // Create deal
    const dealTitle = deal_name ? deal_name : `Join Investor Group - ${source_page}`;
    const dealBody: Record<string, unknown> = {
      title:       dealTitle,
      pipeline_id: Number(PD_PIPELINE),
      stage_id:    Number(PD_STAGE),
    };
    if (personId) dealBody.person_id = personId;

    const dealRes  = await fetch(`${PD_BASE}/deals?api_token=${PD_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dealBody),
    });
    const dealId = (await dealRes.json())?.data?.id;

    // Add note
    if (dealId) {
      const noteLines = [
        `Source: ${source_page}`,
        heard_from    ? `Heard from: ${heard_from}`      : null,
        country       ? `Country: ${country}`             : null,
        accredited    ? `Accredited: ${accredited}`       : null,
        invest_amount ? `Invest amount: ${invest_amount}` : null,
        timeframe     ? `Timeframe: ${timeframe}`         : null,
        message || notes ? `Notes: ${message || notes}`  : null,
        `SMS consent: ${sms_consent}`,
      ].filter(Boolean).join("\n");

      await fetch(`${PD_BASE}/notes?api_token=${PD_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: noteLines, deal_id: dealId }),
      });
    }

    return new Response(JSON.stringify({ success: true, deal_id: dealId }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
