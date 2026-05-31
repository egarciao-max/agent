import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env, ProspectParams } from './types';

const PAQUETES = `
Opción 1 — Sitio básico:       $3,500 MXN pago único + $300-400/mes mantenimiento
Opción 2 — Sitio profesional:  $7,500 MXN pago único + $500-600/mes mantenimiento
Opción 3 — Sitio avanzado:     $12,000 MXN pago único + $800/mes mantenimiento
Opción 4 — Solución completa:  $17,000 MXN pago único + $3,200/mes mantenimiento
`.trim();

interface EmailContent {
  subject: string;
  body: string;
}

async function generateEmailWithClaude(
  prospect: ProspectParams,
  apiKey: string,
): Promise<EmailContent> {
  const prompt = `Eres un agente de ventas de servicios web para pequeñas empresas en México.
Escribe un email de ventas persuasivo en español para el siguiente negocio local en San Luis Potosí, SLP, México:

Nombre del negocio: ${prospect.name}
Categoría: ${prospect.category}
Dirección: ${prospect.address || 'San Luis Potosí, SLP'}
Teléfono: ${prospect.phone || 'No disponible'}

El email debe:
1. Saludar de forma profesional haciendo referencia al negocio por nombre
2. Mencionar que notaste que no tienen sitio web en internet
3. Explicar 2-3 beneficios concretos adaptados a su categoría (ej: restaurante → reservas online, taller → clientes buscan en Google, etc.)
4. Presentar los paquetes disponibles de forma clara y concisa:
${PAQUETES}
5. Recomendar la Opción 1 como punto de entrada ideal para comenzar
6. Indicar que se requiere un anticipo del 50% del paquete elegido para iniciar
7. Incluir los datos de pago: CLABE interbancaria 014700400054513316
8. Mencionar que el sitio queda listo en 7 días hábiles
9. Invitar a responder el email para elegir el paquete y resolver dudas
10. Ser conversacional, cálido y persuasivo; máximo 320 palabras
11. Firmar como "Equipo Web SLP" de "ai.dev.oropezas.com"

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes ni después:
{"subject": "asunto aquí", "body": "cuerpo del email aquí con saltos de línea como \\n"}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content[0]?.text ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in Claude response: ${text.slice(0, 200)}`);

  const parsed = JSON.parse(jsonMatch[0]) as EmailContent;
  if (!parsed.subject || !parsed.body) {
    throw new Error('Invalid email JSON: missing subject or body');
  }

  return parsed;
}

async function sendViaResend(
  to: string,
  subject: string,
  body: string,
  apiKey: string,
): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'ventas@ai.dev.oropezas.com',
      to: [to],
      subject,
      text: body,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }
}

export class ProspectWorkflow extends WorkflowEntrypoint<Env, ProspectParams> {
  async run(event: WorkflowEvent<ProspectParams>, step: WorkflowStep) {
    const prospect = event.payload;

    // Step 1: Generate personalized email with Claude Haiku
    const email = await step.do(
      'generate-email',
      {
        retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
        timeout: '60 seconds',
      },
      async () => {
        return generateEmailWithClaude(prospect, this.env.CLAUDE_API);
      },
    );

    // Step 2: Persist draft to D1
    await step.do(
      'save-draft',
      { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' } },
      async () => {
        await this.env.DB.prepare(`
          UPDATE prospects
          SET email_subject = ?, email_body = ?, updated_at = datetime('now')
          WHERE place_id = ?
        `)
          .bind((email as EmailContent).subject, (email as EmailContent).body, prospect.place_id)
          .run();
      },
    );

    // Step 3: Anti-spam delay between sends
    await step.sleep('anti-spam-delay', '2 seconds');

    // Step 4: Send email or log sin_email
    const sendStatus = await step.do(
      'send-email',
      {
        retries: { limit: 3, delay: '15 seconds', backoff: 'exponential' },
        timeout: '30 seconds',
      },
      async () => {
        if (!prospect.email) {
          return { sent: false };
        }
        await sendViaResend(
          prospect.email,
          (email as EmailContent).subject,
          (email as EmailContent).body,
          this.env.AUTO_RESEND_KEY,
        );
        return { sent: true };
      },
    );

    // Step 5: Update final status in D1
    await step.do(
      'update-status',
      { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' } },
      async () => {
        const status = (sendStatus as { sent: boolean }).sent ? 'contactado' : 'sin_email';
        const sentAt = (sendStatus as { sent: boolean }).sent
          ? new Date().toISOString()
          : null;

        await this.env.DB.prepare(`
          UPDATE prospects
          SET status = ?, email_sent_at = ?, updated_at = datetime('now')
          WHERE place_id = ?
        `)
          .bind(status, sentAt, prospect.place_id)
          .run();
      },
    );
  }
}
