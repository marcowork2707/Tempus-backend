const OpenAI = require('openai');

let cachedClient = null;

function getOpenAIClient() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY is not configured');
    error.code = 'OPENAI_API_KEY_MISSING';
    throw error;
  }

  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey });
  }

  return cachedClient;
}

async function generateReportsAssistantReply({ centerName, month, question, reportContext }) {
  const client = getOpenAIClient();
  const model = String(process.env.OPENAI_ASSISTANT_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.25,
    max_completion_tokens: 550,
    messages: [
      {
        role: 'system',
        content: [
          'Eres el asistente analitico de Tempus para centros deportivos.',
          'Responde siempre en espanol.',
          'Usa solo la informacion incluida en el contexto proporcionado.',
          'Si el contexto no contiene un dato, dilo con claridad y no lo inventes.',
          'Prioriza conclusiones accionables, comparativas y referencias numericas concretas.',
          'Si la pregunta mezcla datos no disponibles, separa lo que si puedes responder de lo que falta.',
          'No cites JSON ni nombres internos de campos salvo que sea necesario para aclarar la respuesta.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Centro: ${centerName || 'Centro sin nombre'}`,
          `Mes de referencia principal: ${month}`,
          `Pregunta: ${question}`,
          'Contexto de informes (JSON):',
          JSON.stringify(reportContext || {}, null, 2),
        ].join('\n\n'),
      },
    ],
  });

  const reply = completion.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    throw new Error('OpenAI returned an empty response');
  }

  return {
    reply,
    model,
  };
}

module.exports = {
  generateReportsAssistantReply,
};