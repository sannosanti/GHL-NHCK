const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GHL_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

const conversationHistory = {};

const humanDelay = () => new Promise(resolve => 
  setTimeout(resolve, Math.floor(Math.random() * 4000) + 2000)
);

async function getContact(contactId) {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    headers: {
      'Authorization': `Bearer ${GHL_KEY}`,
      'Version': '2021-04-15'
    }
  });
  return await res.json();
}

async function getConversationId(contactId) {
  const res = await fetch(`https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}&locationId=${GHL_LOCATION_ID}`, {
    headers: {
      'Authorization': `Bearer ${GHL_KEY}`,
      'Version': '2021-04-15'
    }
  });
  const data = await res.json();
  return data.conversations?.[0]?.id || null;
}

async function getLastMessage(conversationId) {
  const res = await fetch(`https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=5`, {
    headers: {
      'Authorization': `Bearer ${GHL_KEY}`,
      'Version': '2021-04-15'
    }
  });
  const data = await res.json();
  const messages = data.messages?.messages || [];
  const lastInbound = messages.find(m => m.direction === 'inbound');
  return lastInbound?.body || '';
}

async function addTag(contactId, tag) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_KEY}`,
      'Version': '2021-04-15',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tags: [tag] })
  });
}

async function sendMessage(conversationId, message) {
  await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_KEY}`,
      'Version': '2021-04-15',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'WhatsApp',
      conversationId,
      message
    })
  });
}

app.get('/', (req, res) => {
  res.send('Servidor NHC Kids activo ✓');
});

app.post('/webhook/ghl', async (req, res) => {
  try {
    console.log('BODY RECIBIDO:', JSON.stringify(req.body));

    const contactId = req.body.contactId || 
                  req.body.customData?.contactId || 
                  req.body.contact_id ||
                  req.body.contact?.id;

const conversationId_raw = req.body.conversationId || 
                           req.body.customData?.conversationId || '';

let conversationId = conversationId_raw;

const message = req.body.message || 
                req.body.customData?.message || '';

    if (!contactId) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    // Si conversationId está vacío, buscarlo
    if (!conversationId) {
      conversationId = await getConversationId(contactId);
    }

    if (!conversationId) {
      return res.status(400).json({ error: 'No se encontró conversación' });
    }

    // Obtener contacto y etiquetas
    const contactData = await getContact(contactId);
    const contact = contactData.contact || {};
    const tags = contact.tags || [];

    const terminoTriaje = tags.includes('terminó triaje nhck');
    const escalado = tags.includes('escalado nhck');

    if (!terminoTriaje || escalado) {
      return res.json({ success: true, skipped: true });
    }

    // Obtener último mensaje del lead
    const lastMessage = message || await getLastMessage(conversationId);

    if (!lastMessage) {
      return res.json({ success: true, skipped: true, reason: 'No message found' });
    }

    // Obtener campos de triaje
    const customFields = contact.customFields || [];
    const getField = (key) => {
      const field = customFields.find(f => f.fieldKey === key);
      return field ? field.value : 'No respondido';
    };

    const nombre = contact.firstName || 'Hola';
    const triaje1 = getField('triaje_nhc__principal_dificultad');
    const triaje2 = getField('triaje_nhc__tiempo_observando');
    const triaje3 = getField('triaje_nhc__intentos_previos');
    const triaje4 = getField('triaje_nhc__rea_ms_afectada');
    const triaje5 = getField('triaje_nhc__nivel_de_compromiso');

    // Inicializar historial
    if (!conversationHistory[conversationId]) {
      conversationHistory[conversationId] = [];
    }

    conversationHistory[conversationId].push({
      role: 'user',
      content: lastMessage
    });

    if (conversationHistory[conversationId].length > 20) {
      conversationHistory[conversationId] = 
        conversationHistory[conversationId].slice(-20);
    }

    const systemPrompt = `Eres Daniela, asesora de NHC Kids. Escribes por WhatsApp como una persona real — cálida, cercana y profesional.

PERFIL DEL LEAD:
- Nombre: ${nombre}
- Principal dificultad: ${triaje1}
- Tiempo observando: ${triaje2}
- Lo que han intentado: ${triaje3}
- Área más afectada: ${triaje4}
- Nivel de compromiso: ${triaje5}

SOBRE NHC KIDS:
Centro especializado en comprensión integral del neurodesarrollo infantil. No etiquetamos — comprendemos. Ayudamos a familias a entender qué le pasa realmente a su hijo, intervenir con precisión y acompañar el proceso con coherencia.

EL NEUROMAPEO KIDS (programa diagnóstico):
- Neuromapeo cerebral
- Evaluación clínica
- Sesión de devolución estratégica
- Plan de intervención personalizado
Precio: $395.000 COP
Reserva: $100.000 COP (el resto se paga al llegar)

HORARIOS:
- Lunes: 2:00pm - 3:30pm
- Martes a Jueves: 8:30am - 4:30pm
- Viernes: 8:30am - 4:30pm
- Sábado: 8:30am - 10:30am

MANEJO DE OBJECIONES:
- Precio alto → "Lo que cuesta más es seguir sin claridad. La reserva son solo $100.000 y el resto al llegar."
- Dudas si sirve → usa el triaje para personalizar la respuesta
- Horarios → pregunta qué día le queda mejor

ESCALADO — responde SOLO con la palabra [ESCALAR] cuando:
- El lead ya está listo y quiere hablar con alguien del equipo
- Te preguntan algo fuera de tu conocimiento
- El lead lo pide explícitamente
- Ya cerraste el proceso de venta completo

REGLAS:
- Mensajes MUY cortos — máximo 2-3 líneas
- Tono humano y cálido como WhatsApp real
- Nunca digas que eres IA
- Usa el triaje para personalizar siempre
- Solo en español`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: systemPrompt,
        messages: conversationHistory[conversationId]
      })
    });

    const claudeData = await claudeRes.json();
    const reply = claudeData.content[0].text;

    if (reply.includes('[ESCALAR]')) {
      await addTag(contactId, 'escalado nhck');
      await humanDelay();
      await sendMessage(conversationId,
        'En un momento un asesor del área de ventas te va a ayudar con esto 🙌');
      return res.json({ success: true, escalated: true });
    }

    conversationHistory[conversationId].push({
      role: 'assistant',
      content: reply
    });

    await humanDelay();
    await sendMessage(conversationId, reply);

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