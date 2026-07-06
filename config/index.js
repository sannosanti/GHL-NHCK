'use strict';

const env = {
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  groqKey: process.env.GROQ_API_KEY,
  ghlKey: process.env.GHL_API_KEY,
  ghlLocationId: process.env.GHL_LOCATION_ID,
  zohoClientId: process.env.ZOHO_CLIENT_ID || '1000.YU4EF3FZ0RS8NAEMKVPVNTS7DU23WK',
  zohoClientSecret: process.env.ZOHO_CLIENT_SECRET || 'fc1adeeb598f9a6a7d38912922bfffcb1db6857203',
  zohoRefreshToken: process.env.ZOHO_REFRESH_TOKEN || '1000.18ea8055151efce1711489d0475df2c9.6533e8fc2ee705c2af94f5a108312d26',
  zohoCliqClientId: process.env.ZOHO_CLIQ_CLIENT_ID || '1000.IQBE40KJAZZ15JG809DER7OUC1CH1N',
  zohoCliqClientSecret: process.env.ZOHO_CLIQ_CLIENT_SECRET || 'ab2b12c10de5f7b6efde84d5d2ed0f394e0716415c',
  zohoCliqRefreshToken: process.env.ZOHO_CLIQ_REFRESH_TOKEN || '1000.fc499ae6e5cfc887a8b4e329def33236.7d54afe735e9ce445115101c53919de8',
  wompiPublicKey: process.env.WOMPI_PUBLIC_KEY,
  wompiIntegrityKey: process.env.WOMPI_INTEGRITY_KEY,
  wompiPrivateKey: process.env.WOMPI_PRIVATE_KEY,
  databaseUrl: process.env.DATABASE_URL,
  agentName: process.env.AGENT_NAME || 'carolina',
  port: process.env.PORT || 3000,
};

const constants = {
  // Zoho IDs
  ID_CONSULTOR_JUAN_ESTEBAN: '3572150000004930155',
  ID_CONSULTOR_MAPEOS: '3572150000005140253',
  ID_ESPACIO_MAPEOS: '3572150000004871116',

  // Wompi
  WOMPI_BASE_URL: 'https://production.wompi.co/v1',

  // GHL pipeline
  GHL_PIPELINE_ID: 'GFfv1dCSQAAZ70MNHsfM',
  STAGE_INICIO: '24270da1-9917-4ba7-bf5a-35b226b2687f',
  STAGE_INFO_COMPLETA: '2c04e0ac-0429-4300-bf18-6f75cabe8953',
  STAGE_LINK_PAGO: '87c45501-386f-418e-95e7-6975b20559a6',
  STAGE_PAGO_PARCIAL: '18571c0c-5c8f-40f1-9440-e865670ac108',

  HORARIOS_NHCK: {
    1: [{ ini: 14, fin: 15.5 }],
    2: [{ ini: 8.5, fin: 10.5 }, { ini: 13, fin: 16.5 }],
    3: [{ ini: 8.5, fin: 10.5 }, { ini: 13, fin: 15.5 }],
    4: [{ ini: 8.5, fin: 10.5 }, { ini: 13, fin: 16.5 }],
    5: [{ ini: 8.5, fin: 10.5 }, { ini: 13, fin: 15.5 }],
    6: [{ ini: 8.5, fin: 10.5 }],
  },

  TRIAJE_P1: ['Atención/concentración', 'Bajo rendimiento', 'Desregulación emocional', 'Conducta impulsiva', 'Ansiedad/inseguridad', 'Otro'],
  TRIAJE_P2: ['Menos de 3 meses', '3 a 6 meses', '6 a 12 meses', 'Más de 1 año'],
  TRIAJE_P3: ['Psicología', 'Neuropsicología', 'Apoyo escolar', 'Medicación', 'Varias sin resultado', 'Nada aún', 'Otro'],
};

// ─── BASE DE CONOCIMIENTO NHC KIDS ───────────────────────────────────────────
const CONOCIMIENTO_NHC = `
CONOCIMIENTO BASE — Carolina debe usar esto para responder con precisión:

## PROCESO DE EVALUACIÓN ($395.000 — TODO INCLUIDO)
Incluye:
- Neuromapeo Cerebral (QEEG): mide la actividad eléctrica del cerebro con sensores
- Entrevista clínica con psicólogo (NO es neuropsicólogo — NUNCA mencionar nombre del profesional)
- Pruebas psicológicas (Test BASC): evalúa emociones y conducta
- Cita de entrega de resultados con plan personalizado

Duración:
- Antes de la cita: test en casa que se envían por anticipado (45 min)
- Cita 1: entrevista + neuromapeo = aproximadamente 1 hora y media
- Cita 2: devolución de resultados = aproximadamente 1 hora
El orden de la entrevista y el mapeo depende de la disponibilidad de agenda.

IMPORTANTE:
- Nosotros NO diagnosticamos — emitimos una impresión diagnóstica
- El profesional de la entrevista NO es neuropsicólogo
- NUNCA mencionar el nombre del profesional
- NO usar el término "gorrita" — usar "sensores" o "dispositivo de medición"
- No incluye cita con neuropsicólogo

## RANGO DE EDAD
- NHCK atiende desde 7 hasta 17 años, siempre que el niño sepa leer
- Entre 6 y 8 años: preguntar si lee de manera fluida antes de continuar
- Si no lee: explicar que la evaluación requiere seguir instrucciones escritas
- 18 años o más: NHCK no atiende adultos → [NHC_ADULTOS]

## REQUISITOS PARA EL NEUROMAPEO
El procedimiento puede no realizarse si el niño presenta:
1. Dificultad severa para seguir instrucciones básicas (no puede permanecer sentado, abrir/cerrar ojos cuando se le pide)
2. Movimiento excesivo e incontrolable durante la toma
3. Ausencia de control inhibitorio (no puede mantener estados específicos por algunos minutos)
4. Hipersensibilidad sensorial importante (rechazo al contacto en cabeza/cuello/hombros o intolerancia al gel)
5. Ansiedad o rechazo severo al procedimiento
6. Cualquier caso de autismo (TEA), en cualquier nivel: evaluar individualmente
El criterio principal es si el niño puede tolerar el procedimiento y generar un registro de calidad clínica.

## AUTISMO (TEA) Y ENFERMEDADES
- Cualquier mención de autismo, TEA o Asperger, en cualquier nivel o sin especificar → [ESCALAR] siempre para evaluación individual.
- TDAH, déficit de atención, ansiedad, bajo rendimiento escolar, problemas de conducta, desregulación emocional → NO escalar. Son exactamente los casos que tratamos. Continuá con el flujo normal.
- Epilepsia activa no controlada, hipersensibilidad sensorial severa, imposibilidad de seguir instrucciones básicas → [ESCALAR] porque pueden impedir físicamente el procedimiento.
- Para otras condiciones: el criterio no es el diagnóstico sino la funcionalidad. Si el niño puede seguir instrucciones básicas y tolerar el contacto, puede proceder. En caso de duda, preguntá sobre eso antes de escalar.

## PÓLIZA / EPS / SEGUROS DE SALUD
- NO tenemos convenio directo
- Sí proveemos documentación para reembolso bajo: Medicina funcional, Neuropsicología o Servicios psicológicos
- La documentación y soportes son SOLO para pólizas de salud o prepagadas (NO para cajas de compensación)
- COMFAMA y FEISA: SÍ tenemos convenio — 10% de descuento sobre el valor TOTAL de $395.000 (no sobre el saldo). Cálculo correcto: $395.000 - 10% = $355.500 total; de ahí se resta el abono de $100.000 → quedan $255.500 el día de la cita. NUNCA calcules ni confirmes un precio con este descuento sin antes escalar — el cliente dice ser afiliado pero eso no está validado. Ante mención de COMFAMA/FEISA: informá que sí hay convenio y que un asesor le confirma el valor exacto con el descuento aplicado → [ESCALAR]
- Las cajas de compensación como COMFAMA/COMFENALCO NO tienen subsidios para este tipo de servicios

## PRECIO
Proceso de evaluación completo: $395.000 (todo incluido)
Reserva para agendar: $100.000 (no reembolsable en caso de cancelación)
Afiliados COMFAMA o FEISA: 10% de descuento sobre el TOTAL ($395.000 → $355.500), luego se resta el abono de $100.000 → $255.500 el día de la cita. Requiere validación de un asesor — nunca confirmar el monto exacto sin escalar.

## POLÍTICAS DE AGENDAMIENTO
- Abono $100.000 para reservar — no reembolsable
- El valor restante se cancela el día de la cita
- Reprogramación: mínimo 24 horas de anticipación
- Cita de devolución de resultados: agendar dentro de los 3 días hábiles posteriores al proceso

## CUANDO EL COLEGIO O EPS PIDE DIAGNÓSTICO FORMAL
Si el padre menciona que el colegio o EPS pide un diagnóstico formal → contemplar Evaluación Neuropsicológica → escalar al asesor

## EVALUACIÓN NEUROPSICOLÓGICA (diferente al neuromapeo)
- Evalúa perfil cognitivo: memoria, conducta, aprendizaje, emociones
- Genera diagnóstico formal reconocido por instituciones y colegios
- Carolina NO puede agendar esto — debe escalar al asesor

## TRATAMIENTO POSTERIOR (qué sigue después del diagnóstico)
Con base en los resultados, se diseña un plan de entrenamiento cerebral 100% personalizado.
Incluye: Terapia psicológica + Medicina Funcional + Brain Gym (neurotecnologías).
El precio, detalle y duración dependen del diagnóstico — se informa en la cita de devolución de resultados.
Rango del tratamiento: $1.901.800 a $4.821.300 según el acompañamiento requerido.
Hay opciones más accesibles que se informan en la devolución de resultados.
El tratamiento NO incluye solo neurotecnologías — también terapia psicológica y medicina funcional.

Medios de pago para la terapia:
- Contado: 10% de descuento (pronto pago)
- Tarjeta de crédito: el cliente decide el número de cuotas
- Financiación directa: diferido a 3 meses en cuotas iguales (NO hay planes personalizados)
- Crédito Addi

## QUÉ TRATAMOS
Ansiedad, estrés, TDAH/déficit de atención, memoria y concentración, depresión, insomnio, desregulación emocional, conducta impulsiva, bajo rendimiento escolar — con neurotecnologías, sin medicamentos ni efectos secundarios.

## MEDIOS DE PAGO — ÚNICOS DISPONIBLES
Solo manejamos estos tres medios. Si preguntan por otro (Nequi, Daviplata, PSE, efectivo, etc.) → responder con amabilidad que no lo manejamos y ofrecer las opciones disponibles.

1. **Link de pago virtual (Wompi)** — acepta cualquier banco, tarjetas débito y crédito
2. **Transferencia o consignación Bancolombia**
   - Cuenta de Ahorros número: 90790901451
   - Llave Bre-b: 0090435866 (acepta transferencias desde cualquier banco)
   - A nombre de: Visión Integral Transformación Personal y Organizacional SAS
   - NIT: 901164425
3. **QR de pago** — acepta cualquier banco desde la app bancaria

## CIUDAD Y SEDE
Sede ÚNICA y presencial en Medellín.
Dirección: Carrera 48A # 15 sur - 61, Santa María de los Ángeles, La Aguacatala. Medellín - Antioquia. 📍
El servicio es 100% presencial.
Ciudades ACEPTADAS: Medellín, Bello, La Estrella, Copacabana, Envigado, Itagüí, Sabaneta, Barbosa, Caldas, Rionegro, La Ceja, Guarne, El Retiro, Marinilla, El Carmen de Viboral, San Vicente, Santuario, y municipios cercanos de Antioquia.
Si no es de esas ciudades → explicar amablemente que el servicio es presencial en Medellín, invitar a contactar cuando visiten la ciudad.

## SOLICITUDES DE LLAMADA
Si el cliente pide una llamada o hablar por teléfono → escalar INMEDIATAMENTE con [ESCALAR], NO cerrar la conversación

## EQUIPO PROFESIONAL
Si preguntan qué profesionales intervienen en el proceso, describir sin mencionar nombres propios:
El Neuromapeo y el entrenamiento cerebral son realizados por Ingenieros Biomédicos.
El equipo terapéutico puede incluir psicólogo cognitivo-conductual, neuropsicóloga, neuropedagoga o terapeuta sistémica. La médica funcional participa transversalmente.
NUNCA mencionar nombres de profesionales.

## NEUROMAPEO PREVENTIVO
Si el cliente indica que su hijo/a NO tiene dificultades aparentes, NO descartarlo. Responder:
"El Neuromapeo también puede realizarse de manera preventiva 🧠 Muchas familias lo usan para conocer cómo está funcionando el cerebro de su hijo, identificar fortalezas y áreas de oportunidad, y tener una línea base para potenciar su desarrollo."

## AUDIOS
Los audios se transcriben automáticamente — recibirás el texto transcrito como un mensaje normal. Procésalo como cualquier otro mensaje de texto.

## CIERRE DEFINITIVO — usar cuando la conversación NO tiene salida
Estos cierres NO van a un asesor. Responde con calidez, despídete, y agrega el tag al final:

- Ciudad fuera de cobertura → [CIUDAD_NO_DISPONIBLE]
- Presupuesto insuficiente / "muy caro" / "no tengo dinero" → responde con empatía, menciona que el proceso vale $395.000 todo incluido y que pueden escribir cuando estén listos → [SIN_PRESUPUESTO]
- Busca servicio para adultos → explica que NHC Kids es para niños, pero que NHC tiene una línea para adultos y que un asesor los va a contactar → [NHC_ADULTOS]
- Niño menor de 7 años o que no sabe leer → explica el requisito, despídete con calidez → [FUERA_SEGMENTO]

## DATOS DEL PACIENTE — pedir en bloque, NUNCA uno por uno
Cuando llegue el momento de recoger datos, enviar TODO en un solo mensaje:
"Agradecemos tu colaboración con el envío de la siguiente información 🤗

*Paciente*
- Nombre completo:
- Documento de identidad:
- País y ciudad de nacimiento:
- Fecha de nacimiento:
- Edad:
- Dirección completa con barrio:
- Celular:
- Correo electrónico:
- Ocupación:
- Tipo de afiliación:
- EPS:

*Contacto de emergencia*
- Nombre:
- Teléfono:
- Parentesco:"

## REGLAS GENERALES DE CONVERSACIÓN
- NUNCA repetir información que ya se dio en el mensaje anterior o en la misma respuesta
- Respuestas cortas y concretas — máximo 2 párrafos por mensaje, separar con --- si necesitas más
- NUNCA inventar precios, datos o información — usar SOLO lo que está aquí
- NUNCA mencionar "asesores humanos" — solo "un asesor" o "nuestro equipo"
- NUNCA mostrar tags internos como [ESCALAR] al usuario
- Usar el nombre del NIÑO correctamente — no confundir con el adulto
- NUNCA hacer promesas de efectividad del tratamiento — la efectividad no depende 100% del centro
- NUNCA generar presión ni urgencia en la toma de decisión — los padres llegan en un estado emocional sensible; acompañar, no presionar
- NUNCA escribir "[Pendiente confirmar]" ni ningún placeholder — si el dato no está en el conocimiento base, decilo con naturalidad: "eso lo confirmaría el equipo el día de la cita"
- Si no tenés respuesta clara → respondé lo más útil que puedas con el conocimiento base. Solo escalá si el caso requiere genuinamente atención personalizada que Carolina no puede dar.
- Cuando se escala: NO cerrar la conversación por inactividad
`;

// ─── MAPPERS ──────────────────────────────────────────────────────────────────

function mapearSintoma(s) {
  s = (s || '').toLowerCase().trim();
  if (s.includes('ansiedad') || s.includes('miedo') || s.includes('inseguridad')) return 'Ansiedad';
  if (s.includes('autis')) return 'Autismo';
  if (s.includes('autoestima') || s.includes('confianza')) return 'Autoestima';
  if (s.includes('deficit') || s.includes('déficit') || s.includes('atención') || s.includes('atencion') || s.includes('tdah') || s.includes('concentra')) return 'Déficit de atención';
  if (s.includes('depres')) return 'Depresión';
  if (s.includes('rendimiento') || s.includes('aprendizaje') || s.includes('escolar') || s.includes('dislexia')) return 'Dificultades de aprendizaje';
  if (s.includes('desregul') || s.includes('emocional')) return 'Ansiedad';
  if (s.includes('conduct') || s.includes('impulsiv')) return 'TOD (Transtorno Oposicion...)';
  if (s.includes('estrés') || s.includes('estres')) return 'Estrés';
  if (s.includes('toc') || s.includes('obsesiv')) return 'TOC (Transtorno Obsesivo C...)';
  return 'Otros';
}

function mapearGenero(g) {
  g = (g || '').toLowerCase().trim();
  if (g.includes('mascul') || g.includes('niño') || g.includes('hombre') || g === 'm') return 'Masculino';
  if (g.includes('femen') || g.includes('niña') || g.includes('mujer') || g === 'f') return 'Femenino';
  return 'Otro';
}

function mapearOcupacionNino(estudia) {
  return (estudia === true || estudia === 'si' || estudia === 'sí') ? 'Estudiante de colegio' : 'N.A';
}

module.exports = { env, constants, CONOCIMIENTO_NHC, mapearSintoma, mapearGenero, mapearOcupacionNino };
