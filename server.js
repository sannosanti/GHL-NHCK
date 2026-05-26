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
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=5`, {
      headers: {
        'Authorization': `Bearer ${GHL_KEY}`,
        'Version': '2021-04-15'
      }
    });
    const data = await res.json();
    const messages = data.messages?.messages || data.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const lastInbound = messages.find(m => m.direction === 'inbound');
    return lastInbound?.body || messages[0]?.body || '';
  } catch (err) {
    console.error('Error getLastMessage:', err);
    return '';
  }
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

async function sendMessage(conversationId, message, contactId) {
  const res = await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_KEY}`,
      'Version': '2021-04-15',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'WhatsApp',
      conversationId,
      contactId,
      message
    })
  });
  const data = await res.json();
  console.log('SEND MESSAGE RESPONSE:', JSON.stringify(data));
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

    const message = req.body.message?.body || 
                    req.body.customData?.message || '';

    if (!contactId) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    if (!conversationId) {
      conversationId = await getConversationId(contactId);
    }

    if (!conversationId) {
      return res.status(400).json({ error: 'No se encontró conversación' });
    }

    const contactData = await getContact(contactId);
    const contact = contactData.contact || {};
    const tags = contact.tags || [];

    const terminoTriaje = tags.includes('terminó triaje nhck');
    const escalado = tags.includes('escalado nhck');

    if (!terminoTriaje || escalado) {
      return res.json({ success: true, skipped: true });
    }

    const lastMessage = message || await getLastMessage(conversationId);

    if (!lastMessage) {
      return res.json({ success: true, skipped: true, reason: 'No message found' });
    }

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

    console.log('TRIAJE DATA:', { triaje1, triaje2, triaje3, triaje4, triaje5 });

    if (!conversationHistory[conversationId]) {
      conversationHistory[conversationId] = [];
    }

    conversationHistory[conversationId].push({
      role: 'user',
      content: [{ type: 'text', text: lastMessage }]
    });

    if (conversationHistory[conversationId].length > 20) {
      conversationHistory[conversationId] = 
        conversationHistory[conversationId].slice(-20);
    }

    const systemPrompt = `Eres Carolina, asesora experta de NHC Kids. Escribes por WhatsApp como una persona real — cálida, cercana y profesional.

CONTEXTO CRÍTICO:
- ${nombre} es el PADRE o MADRE, no el niño. NUNCA digas "ayudar a ${nombre}".
- Ya completaron el triaje. TIENES toda su información. NUNCA digas que no tienes sus datos.
- Tu primer mensaje SIEMPRE debe demostrar que leíste el triaje — menciona lo que respondieron.

TRIAJE COMPLETADO POR ${nombre}:
- Principal dificultad del hijo/a: ${triaje1}
- Tiempo observando esta situación: ${triaje2}
- Lo que han intentado antes: ${triaje3}
- Área más afectada si no intervienen: ${triaje4}
- Nivel de compromiso familiar: ${triaje5}

SOBRE NHC KIDS:
Centro especializado en comprensión integral del neurodesarrollo infantil.
No etiquetamos — comprendemos.
Ayudamos a familias a entender qué le pasa realmente a su hijo, intervenir con precisión y acompañar el proceso con coherencia.

EL NEUROMAPEO KIDS (programa diagnóstico):
- Neuromapeo cerebral (vemos cómo funciona realmente su cerebro)
- Evaluación clínica completa
- Sesión de devolución estratégica (te explicamos TODO lo que encontramos)
- Plan de intervención personalizado (qué hacer y cómo)
Precio: $395.000 COP
Reserva: $100.000 COP (el resto se paga al llegar)

HORARIOS DISPONIBLES:
- Lunes: 2:00pm - 3:30pm
- Martes a Jueves: 8:30am - 4:30pm
- Viernes: 8:30am - 4:30pm
- Sábado: 8:30am - 10:30am

CÓMO USAR EL TRIAJE EN TUS RESPUESTAS:
- Si pregunta qué hacen → explica el Neuromapeo y conéctalo con su dificultad específica (${triaje1})
- Si pregunta si sirve para su caso → "Sí, especialmente porque llevan ${triaje2} con esta situación y ya intentaron ${triaje3} sin los resultados esperados"
- Si pregunta el precio → explica el valor, menciona la reserva de $100.000
- Si pregunta cuándo → ofrece los horarios disponibles

MANEJO DE OBJECIONES:
- Precio alto → "Lo que cuesta más es seguir sin claridad. La reserva son solo $100.000 y el resto al llegar."
- Dudas si sirve → "Con ${triaje2} observando ${triaje1}, esto es exactamente para lo que está diseñado el neuromapeo."
- Horarios → "¿Qué día te vendría mejor? Tenemos disponibilidad de lunes a sábado."

ESCALADO — responde SOLO con [ESCALAR] cuando:
- El lead está listo para pagar y confirmar cita
- Te preguntan algo fuera de tu conocimiento
- El lead pide hablar con alguien del equipo
- Ya completaste el proceso de venta

REGLAS ESTRICTAS:
- Mensajes MUY cortos — máximo 3 líneas
- Tono humano y cálido como WhatsApp real
- NUNCA digas que eres IA
- NUNCA digas que no tienes información del triaje
- SIEMPRE usa el triaje para personalizar
- Solo en español`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        system: systemPrompt,
        messages: conversationHistory[conversationId]
      })
    });

    const claudeData = await claudeRes.json();
    console.log('CLAUDE RESPONSE:', JSON.stringify(claudeData));
    const reply = claudeData.content[0].text;

    if (reply.includes('[ESCALAR]')) {
      await addTag(contactId, 'escalado nhck');
      await humanDelay();
      await sendMessage(conversationId,
        'En un momento un asesor del área de ventas te va a ayudar con esto 🙌', contactId);
      return res.json({ success: true, escalated: true });
    }

    conversationHistory[conversationId].push({
      role: 'assistant',
      content: [{ type: 'text', text: reply }]
    });

    await humanDelay();
    await sendMessage(conversationId, reply, contactId);

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