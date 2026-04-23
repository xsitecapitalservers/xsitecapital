import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PD_PIPELINE_ID = 4;
const PD_STAGE_ID    = 27; // Webinars

/* ── Next Thursday 6pm ET ─────────────────────────────────────────── */
function getNextWebinarDate(): Date {
  const now   = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etNow = new Date(etStr);
  const day   = etNow.getDay();   // 0=Sun 4=Thu
  const hour  = etNow.getHours();

  let daysAhead = (4 - day + 7) % 7;
  // Thursday after 9pm ET → roll to next Thursday
  if (day === 4 && hour >= 21) daysAhead = 7;
  // Safety: non-Thursday with daysAhead=0 shouldn't happen, but guard it
  if (daysAhead === 0 && day !== 4) daysAhead = 7;

  const target = new Date(etNow);
  target.setDate(etNow.getDate() + daysAhead);
  target.setHours(18, 0, 0, 0); // 6:00 PM ET
  return target;
}

/* ── Sakari: get OAuth token ──────────────────────────────────────── */
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

/* ── Sakari: send one SMS ─────────────────────────────────────────── */
async function sendSMS(token: string, toNumber: string, body: string): Promise<void> {
  const accountId = Deno.env.get('SAKARI_ACCOUNT_ID')!;
  const fromNumber = Deno.env.get('SAKARI_FROM_NUMBER')!;

  const res = await fetch(`https://api.sakari.io/v1/accounts/${accountId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: { toNumber, fromNumber, body },
    }),
  });
  const result = await res.json();
  if (!res.ok) console.error('Sakari send error:', JSON.stringify(result));
  else console.log('SMS sent to', toNumber, ':', result?.data?.id);
}

/* ── Format phone to E.164 ───────────────────────────────────────── */
function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return digits.length >= 7 ? '+' + digits : null;
}

/* ── Main handler ─────────────────────────────────────────────────── */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { first_name, last_name, email, phone, heard_from } = await req.json()
    const fullName = `${first_name} ${last_name}`.trim()

    const webinarDate = getNextWebinarDate();

    // ── 1. Save to Supabase ──────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data: lead, error: dbErr } = await supabase
      .from('leads')
      .insert({
        first_name, last_name, email, phone,
        heard_from,
        source_page:  'Webinar - 35% Tax Strategy',
        webinar_date: webinarDate.toISOString(),
        created_at:   new Date().toISOString(),
      })
      .select()
      .single()

    if (dbErr) console.error('DB error:', dbErr)

    // ── 2. Confirmation SMS ──────────────────────────────────────────
    const e164 = phone ? toE164(phone) : null;
    if (e164) {
      try {
        const token = await getSakariToken();
        const day   = webinarDate.toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric',
          timeZone: 'America/New_York'
        });
        const msg = `Hi ${first_name}! You're confirmed for XSITE Capital's free webinar — Save 35% on Taxes & Know Your Numbers — this ${day} at 6 PM ET. We'll send you the link before we go live. Reply STOP to opt out.`;
        await sendSMS(token, e164, msg);

        // Mark confirmed in DB
        if (lead?.id) {
          await supabase.from('leads').update({ sms_confirmed: true }).eq('id', lead.id);
        }
      } catch(e) { console.error('Confirmation SMS error:', e) }
    }

    // ── 3. Demio registration ────────────────────────────────────────
    let demioData: any = {}
    try {
      const demioPayload: Record<string, string> = {
        id:        Deno.env.get('DEMIO_EVENT_ID')!,
        name:      first_name || fullName,
        last_name: last_name  || '',
        email,
      }
      const digitsOnly = (phone || '').replace(/\D/g, '')
      if (digitsOnly) demioPayload.phone_number = digitsOnly

      const demioRes = await fetch('https://my.demio.com/api/v1/event/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Key':    Deno.env.get('DEMIO_API_KEY')!,
          'Api-Secret': Deno.env.get('DEMIO_API_SECRET')!,
        },
        body: JSON.stringify(demioPayload)
      })
      demioData = await demioRes.json()
      if (demioData.errors) console.error('Demio errors:', JSON.stringify(demioData.errors))
    } catch(e) { console.error('Demio fetch error:', e) }

    // ── 4. Pipedrive ─────────────────────────────────────────────────
    const pdKey  = Deno.env.get('PIPEDRIVE_API_KEY')!
    const pdBase = 'https://api.pipedrive.com/v1'
    let personId: number | undefined
    try {
      const searchRes  = await fetch(`${pdBase}/persons/search?term=${encodeURIComponent(email)}&field=email&api_token=${pdKey}`)
      const searchData = await searchRes.json()
      if (searchData.data?.items?.length > 0) {
        personId = searchData.data.items[0].item.id
      } else {
        const cpRes  = await fetch(`${pdBase}/persons?api_token=${pdKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: fullName, email: [{ value: email, primary: true }], phone: [{ value: phone }] })
        })
        personId = (await cpRes.json()).data?.id
      }
    } catch(e) { console.error('Pipedrive person error:', e) }

    let dealId: number | undefined
    if (personId) {
      try {
        const dealRes  = await fetch(`${pdBase}/deals?api_token=${pdKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title:       'Join Investor Group - Webinar 35% Tax Strategy',
            person_id:   personId,
            pipeline_id: PD_PIPELINE_ID,
            stage_id:    PD_STAGE_ID,
          })
        })
        dealId = (await dealRes.json()).data?.id
        if (dealId) {
          const joinLink = demioData?.join_link || 'N/A'
          await fetch(`${pdBase}/notes?api_token=${pdKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `Webinar: 35% Tax Strategy\nSource: ${heard_from || 'Not specified'}\nDemio link: ${joinLink}`,
              deal_id: dealId,
            })
          })
        }
      } catch(e) { console.error('Pipedrive deal error:', e) }
    }

    if (lead?.id) {
      await supabase.from('leads').update({ pipedrive_person_id: personId, pipedrive_deal_id: dealId }).eq('id', lead.id)
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    })

  } catch (err: any) {
    console.error('Fatal:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }
})
