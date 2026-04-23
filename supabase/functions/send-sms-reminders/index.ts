import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/* ── Sakari helpers ───────────────────────────────────────────────── */
async function getSakariToken(): Promise<string> {
  const res = await fetch('https://auth.sakari.io/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     Deno.env.get('SAKARI_CLIENT_ID')!,
      client_secret: Deno.env.get('SAKARI_CLIENT_SECRET')!,
      audience:      'https://api.sakari.io',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Sakari auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function sendSMS(token: string, toNumber: string, body: string): Promise<boolean> {
  const accountId  = Deno.env.get('SAKARI_ACCOUNT_ID')!;
  const fromNumber = Deno.env.get('SAKARI_FROM_NUMBER')!;
  const res = await fetch(`https://api.sakari.io/v1/accounts/${accountId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { toNumber, fromNumber, body } }),
  });
  const result = await res.json();
  if (!res.ok) { console.error('SMS fail to', toNumber, JSON.stringify(result)); return false; }
  console.log('SMS sent to', toNumber);
  return true;
}

function toE164(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return d.length >= 7 ? '+' + d : null;
}

/* ── Handler ──────────────────────────────────────────────────────── */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // Accepts ?type=dayBefore OR ?type=fifteenMin
  // OR body: { type: "dayBefore" | "fifteenMin" }
  const url    = new URL(req.url);
  let   type   = url.searchParams.get('type');
  if (!type && req.method === 'POST') {
    try { type = (await req.json()).type; } catch (_) {}
  }

  if (!type || !['dayBefore', 'fifteenMin'].includes(type)) {
    return new Response(JSON.stringify({ error: 'type must be dayBefore or fifteenMin' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Find the target Thursday (next Thursday from now in ET)
  const nowET  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dayET  = nowET.getDay();
  let daysToThursday = (4 - dayET + 7) % 7;
  if (daysToThursday === 0) daysToThursday = 0; // it IS Thursday

  const thursday = new Date(nowET);
  thursday.setDate(nowET.getDate() + daysToThursday);
  thursday.setHours(18, 0, 0, 0);

  // Query window: webinar_date within ±4 hours of 6pm ET on that Thursday
  const windowStart = new Date(thursday); windowStart.setHours(14, 0, 0, 0);
  const windowEnd   = new Date(thursday); windowEnd.setHours(22, 0, 0, 0);

  const sentCol = type === 'dayBefore' ? 'sms_reminder1_sent' : 'sms_reminder2_sent';

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, first_name, phone')
    .gte('webinar_date', windowStart.toISOString())
    .lte('webinar_date', windowEnd.toISOString())
    .eq(sentCol, false)
    .not('phone', 'is', null);

  if (error) {
    console.error('DB query error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }

  console.log(`[${type}] Found ${leads?.length ?? 0} leads to SMS`);
  if (!leads || leads.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }

  const token = await getSakariToken();

  const dayLabel = thursday.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    timeZone: 'America/New_York'
  });

  let sent = 0;
  for (const lead of leads) {
    if (!lead.phone) continue;
    const e164 = toE164(lead.phone);
    if (!e164) { console.warn('Bad phone for lead', lead.id, lead.phone); continue; }

    const firstName = lead.first_name || 'there';

    const msg = type === 'dayBefore'
      ? `Hi ${firstName}! Just a reminder — XSITE Capital's free webinar is tomorrow, ${dayLabel} at 6 PM ET. Save 35% on Taxes & Know Your Numbers. See you there! Reply STOP to opt out.`
      : `Hi ${firstName}, your XSITE Capital webinar starts in 15 minutes! Join us now for Save 35% on Taxes & Know Your Numbers. Check your email for the link — we're live at 6 PM ET. Reply STOP to opt out.`;

    const ok = await sendSMS(token, e164, msg);
    if (ok) {
      await supabase.from('leads').update({ [sentCol]: true }).eq('id', lead.id);
      sent++;
    }
    // Small delay to avoid rate-limiting
    await new Promise(r => setTimeout(r, 120));
  }

  return new Response(JSON.stringify({ sent, total: leads.length }), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
})
