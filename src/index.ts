import { scrapeQuery, scrapeAll } from './scraper';
import type { Env, ProspectParams } from './types';

export { ProspectWorkflow } from './workflow';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/health':
        return Response.json({ status: 'ok', timestamp: new Date().toISOString() });

      case '/prospects':
        return handleProspects(url, env);

      case '/prospect':
        if (request.method === 'PATCH') return handleUpdateProspect(request, env);
        break;

      case '/scrape':
        if (request.method === 'POST') return handleScrape(url, env);
        break;
    }

    return new Response('Not Found', { status: 404 });
  },

  async queue(batch: MessageBatch<ProspectParams>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const prospect = message.body;
      try {
        await env.PROSPECT_WORKFLOW.create({ params: prospect });
        message.ack();
      } catch (e) {
        console.error(`Failed to start workflow for ${prospect.place_id}:`, e);
        message.retry();
      }
    }
  },
};

async function handleProspects(url: URL, env: Env): Promise<Response> {
  const status = url.searchParams.get('status');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 500);
  const offset = parseInt(url.searchParams.get('offset') ?? '0');

  const where = status ? 'WHERE status = ?' : '';
  const bindings: (string | number)[] = [];
  if (status) bindings.push(status);

  const [rows, count] = await Promise.all([
    env.DB.prepare(`SELECT * FROM prospects ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, limit, offset)
      .all(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM prospects ${where}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);

  const stats = await env.DB.prepare(`
    SELECT status, COUNT(*) as count FROM prospects GROUP BY status
  `).all<{ status: string; count: number }>();

  return Response.json({
    total: count?.total ?? 0,
    limit,
    offset,
    stats: Object.fromEntries(stats.results.map((r) => [r.status, r.count])),
    prospects: rows.results,
  });
}

async function handleScrape(url: URL, env: Env): Promise<Response> {
  const query = url.searchParams.get('query');
  const pageToken = url.searchParams.get('pagetoken') ?? undefined;

  try {
    if (query) {
      const result = await scrapeQuery(query, env, pageToken);
      return Response.json({ ok: true, results: [result] });
    }
    const results = await scrapeAll(env);
    return Response.json({ ok: true, results });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error }, { status: 500 });
  }
}

async function handleUpdateProspect(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    place_id?: string;
    status?: string;
    email?: string;
  };

  if (!body.place_id || !body.status) {
    return Response.json({ error: 'place_id and status are required' }, { status: 400 });
  }

  const validStatuses = ['nuevo', 'contactado', 'sin_email', 'cerrado', 'error'];
  if (!validStatuses.includes(body.status)) {
    return Response.json(
      { error: `status must be one of: ${validStatuses.join(', ')}` },
      { status: 400 },
    );
  }

  if (body.email) {
    await env.DB.prepare(`
      UPDATE prospects SET status = ?, email = ?, updated_at = datetime('now') WHERE place_id = ?
    `)
      .bind(body.status, body.email, body.place_id)
      .run();
  } else {
    await env.DB.prepare(`
      UPDATE prospects SET status = ?, updated_at = datetime('now') WHERE place_id = ?
    `)
      .bind(body.status, body.place_id)
      .run();
  }

  return Response.json({ ok: true });
}
