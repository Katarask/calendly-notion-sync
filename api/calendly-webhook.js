const { Client } = require('@notionhq/client');
const Anthropic = require('@anthropic-ai/sdk');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DATABASE_ID = 'cf202b0ad8544bea8bd7f427efc6eedb';
const APIFY_TOKEN = process.env.APIFY_API_KEY;

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { event, payload } = req.body;

    // Only process invitee.created events
    if (event !== 'invitee.created') {
      return res.status(200).json({ message: 'Event ignored' });
    }

    const { name, email, questions_and_answers } = payload;

    // Extract answers from Calendly questions
    const getAnswer = (questionKeyword) => {
      const qa = questions_and_answers?.find(q => 
        q.question?.toLowerCase().includes(questionKeyword.toLowerCase())
      );
      return qa?.answer || '';
    };

    // Get LinkedIn URL from answers
    const linkedinUrl = getAnswer('linkedin');

    // 1. Create Notion candidate entry
    const notionPage = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        'Name': {
          title: [{ text: { content: name || 'Unbekannt' } }]
        },
        'E-Mail': {
          email: email || null
        },
        'Position': {
          rich_text: [{ text: { content: getAnswer('position') } }]
        },
        'Kündigungsfrist': {
          rich_text: [{ text: { content: getAnswer('kündigungsfrist') } }]
        },
        'Gesuchte Region': {
          rich_text: [{ text: { content: getAnswer('region') } }]
        },
        'Gehaltsvorstellung': {
          rich_text: [{ text: { content: getAnswer('gehalt') } }]
        },
        'LinkedIn URL': {
          url: linkedinUrl || null
        },
        'Pipeline Status': {
          status: { name: 'Erstgespräch' }
        }
      }
    });

    console.log('Notion page created:', notionPage.id);

    // 2. If LinkedIn URL exists, do enrichment (AWAIT - don't run in background)
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
    return res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    });
  }
};

// Async function to enrich with LinkedIn data
async function enrichWithLinkedIn(notionPageId, linkedinUrl, candidateName) {
  console.log('Starting LinkedIn scrape for:', linkedinUrl);

  // 1. Run Apify LinkedIn scraper
  const linkedinData = await scrapeLinkedIn(linkedinUrl);
  
  if (!linkedinData) {
    throw new Error('No LinkedIn data returned');
  }

  console.log('LinkedIn data received, generating briefing...');

  // 2. Generate AI briefing with Claude
  const briefing = await generateBriefing(linkedinData, candidateName);

  // 3. Extract key information
  const employers = extractEmployers(linkedinData);
  const headline = linkedinData.headline || '';
  const summary = linkedinData.summary || linkedinData.about || '';

  // 4. Update Notion with enriched data
  await notion.pages.update({
    page_id: notionPageId,
    properties: {
      'Meeting Briefing': {
        rich_text: [{ text: { content: briefing.substring(0, 2000) } }]
      },
      'Ehemalige Arbeitgeber': {
        rich_text: [{ text: { content: employers.substring(0, 2000) } }]
      },
      'LinkedIn Headline': {
        rich_text: [{ text: { content: headline.substring(0, 2000) } }]
      },
      'LinkedIn Summary': {
        rich_text: [{ text: { content: summary.substring(0, 2000) } }]
      }
    }
  });

  console.log('Notion updated with LinkedIn enrichment');
}

// Scrape LinkedIn profile using Apify
async function scrapeLinkedIn(profileUrl) {
  // Start the actor run
  const runResponse = await fetch(
    `https://api.apify.com/v2/acts/apimaestro~linkedin-profile-detail/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileUrls: [profileUrl]
      })
    }
  );

  const runData = await runResponse.json();
  const runId = runData.data?.id;

  if (!runId) {
    throw new Error('Failed to start Apify actor: ' + JSON.stringify(runData));
  }

  console.log('Apify run started:', runId);

  // Wait for completion (poll every 3 seconds, max 90 seconds)
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
      // Get results
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

// Generate AI briefing with Claude
async function generateBriefing(linkedinData, candidateName) {
  const prompt = `Du bist ein Recruiting-Assistent für einen Headhunter in der Defense & Aerospace Branche.

Analysiere dieses LinkedIn-Profil und erstelle ein Briefing für das kommende Gespräch.

KANDIDAT: ${candidateName}

LINKEDIN DATEN:
${JSON.stringify(linkedinData, null, 2)}

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
    messages: [
      { role: 'user', content: prompt }
    ]
  });

  return response.content[0]?.text || 'Briefing konnte nicht generiert werden.';
}

// Extract employers from LinkedIn data
function extractEmployers(linkedinData) {
  const experiences = linkedinData.experience || linkedinData.positions || [];
  
  if (!Array.isArray(experiences) || experiences.length === 0) {
    return 'Keine Arbeitgeber gefunden';
  }

  return experiences
    .map(exp => {
      const company = exp.companyName || exp.company || 'Unbekannt';
      const title = exp.title || exp.position || '';
      const duration = exp.duration || exp.dateRange || '';
      return `• ${company}${title ? ` - ${title}` : ''}${duration ? ` (${duration})` : ''}`;
    })
    .slice(0, 10)
    .join('\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
