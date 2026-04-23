# XSITE Leads — Supabase + Pipedrive Setup

## Project Details
- **Project:** xsite-leads
- **Project ID:** nexoqtixosktdlgqorzb
- **Supabase URL:** https://nexoqtixosktdlgqorzb.supabase.co
- **Anon Key (safe for frontend):** eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5leG9xdGl4b3NrdGRsZ3FvcnpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NzU3MTYsImV4cCI6MjA5MjU1MTcxNn0.z6mKjCGZfcGmzaltEIYNl8-76OWZTo685M294KIJGgI
- **Edge Function URL:** https://nexoqtixosktdlgqorzb.supabase.co/functions/v1/submit-lead

## Environment Secrets (set in Supabase Dashboard)
Go to: Project → Edge Functions → submit-lead → Secrets

Add these secrets:
| Key | Value |
|-----|-------|
| PIPEDRIVE_API_KEY | your-pipedrive-api-key |
| PIPEDRIVE_PIPELINE_ID | 4 |
| PIPEDRIVE_STAGE_ID | 28 |

**Pipeline:** Incoming Leads (ID: 4)
**Stage:** Website / SM (ID: 28)

SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

## How It Works
1. User submits form → POST to Edge Function
2. Edge Function saves lead to `leads` table in Supabase
3. Edge Function creates/finds Person in Pipedrive, creates Deal, adds Note
4. If Pipedrive is down, lead is still safe in Supabase

## Form Submission Code (add to each HTML page)
```html
<script>
const SUPABASE_FN_URL = 'https://nexoqtixosktdlgqorzb.supabase.co/functions/v1/submit-lead';

async function submitLead(formEl, sourcePage) {
  const data = Object.fromEntries(new FormData(formEl));
  const payload = {
    first_name:     data.first_name || data.name?.split(' ')[0] || '',
    last_name:      data.last_name  || data.name?.split(' ').slice(1).join(' ') || '',
    email:          data.email,
    phone:          data.phone || '',
    accredited:     data.accredited || '',
    invest_amount:  data.invest_amount || '',
    timeframe:      data.timeframe || '',
    message:        data.message || '',
    sms_consent:    data.sms_consent === 'on' || data.sms_consent === 'true',
    source_page:    sourcePage,
  };

  const res = await fetch(SUPABASE_FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return res.json();
}
</script>
```

## Render Deployment (static site)
1. Push all HTML/CSS/JS files to a GitHub repo
2. On Render: New → Static Site → connect GitHub repo
3. Build command: (leave blank)
4. Publish directory: `.` (root)
5. Done — no server needed, all API calls go to Supabase Edge Functions

## View Your Leads
Supabase Dashboard → Table Editor → leads table
