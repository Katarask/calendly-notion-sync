const { Client } = require('@notionhq/client');
const Anthropic = require('@anthropic-ai/sdk');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DATABASE_ID = 'cf202b0ad8544bea8bd7f427efc6eedb';
const APIFY_TOKEN = process.env.APIFY_API_KEY;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { event, payload } = req.body;
    if (event !== 'invitee.created') return res.status(200).json({ message: 'Event ignored' });

    const { name, email, questions_and_answers } = payload;

    const getAnswer = (questionKeyword) => {
      const qa = questions_and_answers?.find(q => 
        q.question?.toLowerCase().includes(questionKeyword.toLowerCase())
      );
      return qa?.answer || '';
    };

    const linkedinUrl = getAnswer('linkedin');

    // 1. Create Notion candidate entry
    const notionPage = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        'Name': { title: [{ text: { content: name || 'Unbekannt' } }] },
        'E-Mail': { email: email || null },
        'Position': { rich_text: [{ text: { content: getAnswer('position') } }] },
        'Kündigungsfrist': { rich_text: [{ text: { content: getAnswer('kündigungsfrist') } }] },
        'Gesuchte Region': { rich_text: [{ text: { content: getAnswer('region') } }] },
        'Gehaltsvorstellung': { rich_text: [{ text: { content: getAnswer('gehalt') } }] },
        'LinkedIn URL': { url: linkedinUrl || null },
        'Pipeline Status': { status: { name: 'Erstgespräch' } }
      }
    });

    console.log('Notion page created:', notionPage.id);

    // 2. LinkedIn enrichment
    let enrichmentResult = 'skipped';
    if (linkedinUrl) {
      try {
        await enrichWithLinkedIn(notionPage.id, linkedinUrl, name);
        enrichmentResult = 'success';
      } catch (err) {
        console.error('LinkedIn enrichment failed:', err);
        enrichmentResult = 'failed: ' + err.message;
      }
    }

    return res.status(200).json({ 
      success: true, 
      notionPageId: notionPage.id,
      linkedinEnrichment: enrichmentResult
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

async function enrichWithLinkedIn(notionPageId, linkedinUrl, candidateName) {
  console.log('Starting LinkedIn scrape for:', linkedinUrl);

  const linkedinData = await scrapeLinkedIn(linkedinUrl);
  if (!linkedinData) throw new Error('No LinkedIn data returned');

  console.log('LinkedIn data received, generating briefing...');

  const briefing = await generateBriefing(linkedinData, candidateName);
  const employers = extractEmployers(linkedinData);
  const headline = linkedinData.headline || '';
  const summary = linkedinData.about || '';

  await notion.pages.update({
    page_id: notionPageId,
    properties: {
      'Meeting Briefing': { rich_text: [{ text: { content: briefing.substring(0, 2000) } }] },
      'Ehemalige Arbeitgeber': { rich_text: [{ text: { content: employers.substring(0, 2000) } }] },
      'LinkedIn Headline': { rich_text: [{ text: { content: headline.substring(0, 2000) } }] },
      'LinkedIn Summary': { rich_text: [{ text: { content: summary.substring(0, 2000) } }] }
    }
  });

  console.log('Notion updated with LinkedIn enrichment');
}

// Using dev_fusion LinkedIn scraper (correct results)
async function scrapeLinkedIn(profileUrl) {
  const runResponse = await fetch(
    `https://api.apify.com/v2/acts/dev_fusion~linkedin-profile-scraper/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileUrls: [profileUrl] })
    }
  );

  const runData = await runResponse.json();
  const runId = runData.data?.id;
  if (!runId) throw new Error('Failed to start Apify actor: ' + JSON.stringify(runData));

  console.log('Apify run started:', runId);

  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts) {
    await sleep(3000);
    
    const statusResponse = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    const statusData = await statusResponse.json();
    
    console.log('Apify status:', statusData.data?.status);
    
    if (statusData.data?.status === 'SUCCEEDED') {
      const datasetId = statusData.data.defaultDatasetId;
      const resultsResponse = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`
      );
      const results = await resultsResponse.json();
      return results[0] || null;
    }
    
    if (statusData.data?.status === 'FAILED' || statusData.data?.status === 'ABORTED') {
      throw new Error(`Apify run failed: ${statusData.data?.status}`);
    }
    
    attempts++;
  }

  throw new Error('Apify run timed out');
}

async function generateBriefing(linkedinData, candidateName) {
  const prompt = `Du bist ein Recruiting-Assistent für einen Headhunter in der Defense & Aerospace Branche.

Analysiere dieses LinkedIn-Profil und erstelle ein Briefing für das kommende Gespräch.

KANDIDAT: ${candidateName || linkedinData.fullName}

LINKEDIN DATEN:
- Name: ${linkedinData.fullName}
- Headline: ${linkedinData.headline}
- Aktueller Job: ${linkedinData.jobTitle} bei ${linkedinData.companyName}
- Standort: ${linkedinData.addressWithCountry}
- About: ${linkedinData.about || 'Nicht angegeben'}
- Erfahrung: ${JSON.stringify(linkedinData.experiences || [], null, 2)}
- Ausbildung: ${JSON.stringify(linkedinData.educations || [], null, 2)}
- Skills: ${linkedinData.skills?.map(s => s.title).join(', ') || 'Nicht angegeben'}

Erstelle ein strukturiertes Briefing mit:

## Kurzprofil
(2-3 Sätze: Wer ist die Person, aktuelle Rolle, Erfahrungslevel)

## Ehemalige Arbeitgeber & Projekte
(Liste der relevanten Stationen mit Fokus auf Defense/Aerospace/Engineering)

## Technische Skills
(Relevante Technologien und Fachkenntnisse)

## Gesprächsleitfaden
- Einstiegsfragen
- Wichtige Punkte zum Ansprechen
- Mögliche Red Flags oder Highlights

## Einschätzung
(Kurze Bewertung: Passt der Kandidat typischerweise zu Defense/Aerospace Positionen?)

Halte das Briefing prägnant und actionable - max. 1500 Zeichen.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0]?.text || 'Briefing konnte nicht generiert werden.';
}

function extractEmployers(linkedinData) {
  const experiences = linkedinData.experiences || [];
  if (!Array.isArray(experiences) || experiences.length === 0) {
    return 'Keine Arbeitgeber gefunden';
  }

  return experiences
    .map(exp => {
      const company = exp.companyName || 'Unbekannt';
      const title = exp.title || '';
      const duration = exp.duration || '';
      return `• ${company}${title ? ` - ${title}` : ''}${duration ? ` (${duration})` : ''}`;
    })
    .slice(0, 10)
    .join('\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
