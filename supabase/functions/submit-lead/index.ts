import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const body = await req.json();
    const {
      first_name = "",
      last_name = "",
      email = "",
      phone = "",
      accredited = "",
      invest_amount = "",
      timeframe = "",
      message = "",
      notes = "",
      sms_consent = false,
      source_page = "",
      deal_name = "",        // ← custom deal name override
      heard_from = "",
    } = body;

    // Save to Supabase
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { error: dbError } = await supabase.from("leads").insert({
      first_name,
      last_name,
      email,
      phone,
      accredited,
      invest_amount,
      timeframe,
      message: message || notes,
      sms_consent: Boolean(sms_consent),
      source_page,
    });

    if (dbError) console.error("DB error:", dbError);

    // Pipedrive
    const PD_KEY = Deno.env.get("PIPEDRIVE_API_KEY");
    const PD_PIPELINE = Deno.env.get("PIPEDRIVE_PIPELINE_ID") ?? "4";
    const PD_STAGE = Deno.env.get("PIPEDRIVE_STAGE_ID") ?? "28";
    const PD_BASE = `https://api.pipedrive.com/v1`;

    if (!PD_KEY) throw new Error("PIPEDRIVE_API_KEY not set");

    // Find or create person
    const searchRes = await fetch(
      `${PD_BASE}/persons/search?term=${encodeURIComponent(email)}&fields=email&api_token=${PD_KEY}`
    );
    const searchData = await searchRes.json();
    let personId: number | null = null;
    if (searchData?.data?.items?.length > 0) {
      personId = searchData.data.items[0].item.id;
    } else {
      const createPerson = await fetch(`${PD_BASE}/persons?api_token=${PD_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${first_name} ${last_name}`.trim(),
          email: [{ value: email, primary: true }],
          phone: phone ? [{ value: phone, primary: true }] : undefined,
        }),
      });
      const personData = await createPerson.json();
      personId = personData?.data?.id ?? null;
    }

    // Build deal title: use deal_name if provided, else default format
    const dealTitle = deal_name
      ? deal_name
      : `Join Investor Group - ${source_page}`;

    // Create deal
    const dealBody: Record<string, unknown> = {
      title: dealTitle,
      pipeline_id: Number(PD_PIPELINE),
      stage_id: Number(PD_STAGE),
    };
    if (personId) dealBody.person_id = personId;

    const dealRes = await fetch(`${PD_BASE}/deals?api_token=${PD_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dealBody),
    });
    const dealData = await dealRes.json();
    const dealId = dealData?.data?.id;

    // Add note
    if (dealId) {
      const noteLines = [
        `Source: ${source_page}`,
        heard_from ? `Heard from: ${heard_from}` : null,
        accredited ? `Accredited: ${accredited}` : null,
        invest_amount ? `Invest amount: ${invest_amount}` : null,
        timeframe ? `Timeframe: ${timeframe}` : null,
        message || notes ? `Notes: ${message || notes}` : null,
        `SMS consent: ${sms_consent}`,
      ].filter(Boolean).join("\n");

      await fetch(`${PD_BASE}/notes?api_token=${PD_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: noteLines, deal_id: dealId }),
      });
    }

    return new Response(
      JSON.stringify({ success: true, deal_id: dealId }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
