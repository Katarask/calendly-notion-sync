# Calendly to Notion Sync

Ersetzt das Make.com Szenario "Calendly to Notion (Kandidaten-Datenbank)" durch eine kostenlose Vercel Serverless Function.

## Setup

### 1. Deploy to Vercel
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Katarask/calendly-notion-sync)

### 2. Environment Variables in Vercel
- `NOTION_API_KEY`: Dein Notion Integration Token

### 3. Calendly Webhook einrichten
1. Gehe zu Calendly Developer Portal
2. Erstelle Webhook mit URL: `https://dein-projekt.vercel.app/api/calendly-webhook`
3. Event: `invitee.created`

## Felder-Mapping

| Calendly | Notion |
|----------|--------|
| Name | Name |
| Email | E-Mail |
| Frage 1 | Position |
| Frage 2 | Kündigungsfrist |
| Frage 3 | Gesuchte Region |
| Frage 4 | Gehaltsvorstellung |
| Frage 5 | Beschäftigungsverhältnis |
| Frage 6 | Arbeitszeit |
| Frage 7 | Home-Office |
| Frage 8 | Vertragsform |
| Frage 9 | LinkedIn URL |

## Kosten: 0€ (Vercel Free Tier)
