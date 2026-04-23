const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serves your HTML files

// ── Pipedrive config ────────────────────────────────────────────────────────
const PD_API_KEY  = process.env.PIPEDRIVE_API_KEY;   // set in Render dashboard
const PD_BASE     = 'https://api.pipedrive.com/v1';

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: call Pipedrive API
// ─────────────────────────────────────────────────────────────────────────────
async function pipedrive(endpoint, method = 'GET', body = null) {
  const url = `${PD_BASE}${endpoint}?api_token=${PD_API_KEY}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Pipedrive API error');
  return data.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: find or create a Person by email
//   — avoids duplicate contacts if someone submits twice
// ─────────────────────────────────────────────────────────────────────────────
async function findOrCreatePerson({ firstName, lastName, email, phone }) {
  // Search by email first
  const url = `${PD_BASE}/persons/search?term=${encodeURIComponent(email)}&field=email&api_token=${PD_API_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();

  if (data.success && data.data?.items?.length > 0) {
    return data.data.items[0].item.id; // person already exists
  }

  // Create new person
  const person = await pipedrive('/persons', 'POST', {
    name:  `${firstName} ${lastName}`,
    email: [{ value: email, primary: true, label: 'work' }],
    phone: [{ value: phone, primary: true, label: 'mobile' }],
  });

  return person.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: add a note to a deal
// ─────────────────────────────────────────────────────────────────────────────
async function addNote(dealId, content) {
  await pipedrive('/notes', 'POST', {
    deal_id: dealId,
    content,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/submit-lead
//
// Pipedrive field mapping:
//
//   Person fields:
//     name        → firstName + lastName
//     email       → email
//     phone       → phone
//
//   Deal fields:
//     title       → "FirstName LastName — XSITE Website Inquiry"
//     pipeline_id → your Pipedrive pipeline  (set PIPELINE_ID env var)
//     stage_id    → first stage of pipeline  (set STAGE_ID env var)
//     value       → 125000 (avg. investment — update if needed)
//     currency    → USD
//
//   Note added to deal:
//     Source      → where they heard about XSITE
//     Accredited  → accreditation status
//     Form        → which page the form was on
//     Consent     → SMS consent Y/N
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/submit-lead', async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      source,
      accredited,
      smsConsent,
      formPage,      // "contact" | "faq"
    } = req.body;

    // Basic server-side validation
    if (!firstName || !lastName || !email || !phone) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email address' });
    }

    // 1. Find or create the Person in Pipedrive
    const personId = await findOrCreatePerson({ firstName, lastName, email, phone });

    // 2. Create the Deal linked to that Person
    const deal = await pipedrive('/deals', 'POST', {
      title:       `${firstName} ${lastName} — XSITE Website Inquiry`,
      person_id:   personId,
      pipeline_id: parseInt(process.env.PIPELINE_ID || '1'),   // ← set in Render
      stage_id:    parseInt(process.env.STAGE_ID    || '1'),   // ← set in Render
      value:       125000,   // average investment amount; adjust as needed
      currency:    'USD',
      status:      'open',
    });

    // 3. Add a note with the extra form context
    const accreditedLabels = {
      'yes-income':   'Yes — income over $200K',
      'yes-networth': 'Yes — net worth over $1M',
      'no':           'Not yet accredited',
      'unsure':       'Unsure',
    };

    const noteContent = [
      `<b>Lead Source:</b> ${source || 'Not specified'}`,
      `<b>Accredited Investor:</b> ${accreditedLabels[accredited] || accredited || 'Not specified'}`,
      `<b>SMS Consent:</b> ${smsConsent ? 'Yes' : 'No'}`,
      `<b>Form:</b> ${formPage === 'faq' ? 'FAQ Page' : 'Contact Page'}`,
      `<b>Submitted:</b> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`,
    ].join('<br>');

    await addNote(deal.id, noteContent);

    console.log(`✅ Lead created — Deal #${deal.id} for ${firstName} ${lastName}`);
    return res.json({ success: true, dealId: deal.id });

  } catch (err) {
    console.error('❌ Pipedrive error:', err.message);
    return res.status(500).json({ success: false, error: 'Could not create lead. Please try again.' });
  }
});

// ── Health check (Render uses this to verify the service is up) ─────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Catch-all: serve index.html for any unmatched route ─────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`XSITE server running on port ${PORT}`));
