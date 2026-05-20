const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GHL_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

app.get('/', (req, res) => {
  res.send('Servidor NHC Kids activo ✓');
});

app.post('/webhook/ghl', async (req, res) => {
  try {
    const { contactId, message, conversationId } = req.body;

    if (!message || !contactId) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `Eres un asistente de NHC Kids. Tu rol es hacer el triaje inicial de familias que contactan por WhatsApp sobre dificultades de sus hijos. Debes ser empático, cálido y profesional. Responde siempre en español.`,
        messages: [{ role: 'user', content: message }]
      })
    });

    const claudeData = await claudeRes.json();
    const reply = claudeData.content[0].text;

    await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_KEY}`,
        'Version': '2021-04-15',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'WhatsApp',
        conversationId: conversationId,
        message: reply
      })
    });

    res.json({ success: true, reply });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});