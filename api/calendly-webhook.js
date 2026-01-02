const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = '42c178b0-55fd-42b1-b126-d9ad02dc3fba';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;
    console.log('Received Calendly webhook:', JSON.stringify(payload, null, 2));

    if (payload.event !== 'invitee.created') {
      return res.status(200).json({ message: 'Event ignored', event: payload.event });
    }

    const inviteePayload = payload.payload;
    const questionsAndAnswers = inviteePayload.questions_and_answers || [];
    
    const getAnswer = (position) => {
      const qa = questionsAndAnswers[position - 1];
      return qa ? qa.answer : '';
    };

    const name = inviteePayload.name || '';
    const email = inviteePayload.email || '';
    const position = getAnswer(1);
    const kuendigungsfrist = getAnswer(2);
    const gesuchteRegion = getAnswer(3);
    const gehaltsvorstellung = getAnswer(4);
    const beschaeftigungsverhaeltnis = getAnswer(5);
    const arbeitszeit = getAnswer(6);
    const homeOffice = getAnswer(7);
    const vertragsform = getAnswer(8);
    const linkedinUrl = getAnswer(9);

    const properties = {
      'Name': { title: [{ text: { content: name } }] },
      'E-Mail': { email: email || null },
      'Position': { rich_text: [{ text: { content: position } }] },
      'Kündigungsfrist': { rich_text: [{ text: { content: kuendigungsfrist } }] },
      'Gesuchte Region': { rich_text: [{ text: { content: gesuchteRegion } }] },
      'Gehaltsvorstellung': { rich_text: [{ text: { content: gehaltsvorstellung } }] },
      'Pipeline Status': { status: { name: 'Neu eingegangen' } }
    };

    // Multi-select: Beschäftigungsverhältnis
    if (beschaeftigungsverhaeltnis) {
      const validOptions = ['ANÜ', 'Festanstellung', 'Freelance'];
      const selectedOptions = beschaeftigungsverhaeltnis.split(',').map(s => s.trim()).filter(s => validOptions.includes(s));
      if (selectedOptions.length > 0) {
        properties['Beschäftigungsverhältnis'] = { multi_select: selectedOptions.map(name => ({ name })) };
      }
    }

    // Select: Arbeitszeit
    if (arbeitszeit) {
      const validOptions = ['Vollzeit', 'Teilzeit', 'Flexibel'];
      const matched = validOptions.find(opt => arbeitszeit.toLowerCase().includes(opt.toLowerCase()));
      if (matched) properties['Arbeitszeit'] = { select: { name: matched } };
    }

    // Select: Home-Office
    if (homeOffice) {
      const validOptions = ['Remote', 'Hybrid', 'Vor Ort', 'Flexibel'];
      const matched = validOptions.find(opt => homeOffice.toLowerCase().includes(opt.toLowerCase()));
      if (matched) properties['Home-Office'] = { select: { name: matched } };
    }

    // Multi-select: Vertragsform
    if (vertragsform) {
      const validOptions = ['Unbefristet', 'Befristet', 'Projektarbeit'];
      const selectedOptions = vertragsform.split(',').map(s => s.trim()).filter(s => validOptions.includes(s));
      if (selectedOptions.length > 0) {
        properties['Vertragsform'] = { multi_select: selectedOptions.map(name => ({ name })) };
      }
    }

    // URL: LinkedIn
    if (linkedinUrl && linkedinUrl.includes('linkedin.com')) {
      properties['LinkedIn URL'] = { url: linkedinUrl };
    }

    const response = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: properties
    });

    console.log('Created Notion page:', response.id);
    return res.status(200).json({ success: true, notionPageId: response.id, candidateName: name });

  } catch (error) {
    console.error('Error processing webhook:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};
