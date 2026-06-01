import type { Env, ProspectParams } from './types';

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

const SEARCH_QUERIES = [
  'restaurantes San Luis Potosí SLP México',
  'talleres mecánicos San Luis Potosí SLP México',
  'tiendas ropa San Luis Potosí SLP México',
  'panaderías pastelerías San Luis Potosí SLP México',
  'ferreterías materiales San Luis Potosí SLP México',
  'salones belleza estéticas San Luis Potosí SLP México',
  'consultorios médicos San Luis Potosí SLP México',
  'farmacias boticas San Luis Potosí SLP México',
];

const TYPE_TO_CATEGORY: Record<string, string> = {
  restaurant: 'Restaurante',
  food: 'Alimentos',
  bar: 'Bar',
  cafe: 'Café',
  bakery: 'Panadería/Pastelería',
  car_repair: 'Taller Mecánico',
  car_dealer: 'Distribuidor de Autos',
  clothing_store: 'Tienda de Ropa',
  department_store: 'Tienda Departamental',
  hardware_store: 'Ferretería',
  pharmacy: 'Farmacia',
  hair_care: 'Peluquería/Estética',
  beauty_salon: 'Salón de Belleza',
  gym: 'Gimnasio',
  doctor: 'Consultorio Médico',
  dentist: 'Consultorio Dental',
  school: 'Escuela',
  store: 'Tienda',
  supermarket: 'Supermercado',
  lodging: 'Hospedaje',
  laundry: 'Lavandería',
  electrician: 'Servicio Eléctrico',
  plumber: 'Plomería',
  painter: 'Pintura',
  florist: 'Floristería',
  jewelry_store: 'Joyería',
  shoe_store: 'Zapatería',
  furniture_store: 'Mueblería',
  electronics_store: 'Electrónica',
  pet_store: 'Veterinaria/Mascotas',
};

function getCategory(types: string[]): string {
  for (const type of types) {
    if (TYPE_TO_CATEGORY[type]) return TYPE_TO_CATEGORY[type];
  }
  return 'Negocio Local';
}

interface PlaceSummary {
  place_id: string;
  name: string;
  types: string[];
}

interface PlaceDetails {
  place_id: string;
  name: string;
  formatted_address?: string;
  formatted_phone_number?: string;
  website?: string;
  types: string[];
}

interface TextSearchResponse {
  results: PlaceSummary[];
  next_page_token?: string;
  status: string;
}

interface PlaceDetailsResponse {
  result?: PlaceDetails;
  status: string;
}

async function searchPlaces(
  query: string,
  apiKey: string,
  pageToken?: string,
): Promise<{ places: PlaceSummary[]; nextPageToken?: string }> {
  const params = new URLSearchParams({
    query,
    key: apiKey,
    language: 'es',
    region: 'mx',
  });
  if (pageToken) params.set('pagetoken', pageToken);

  const res = await fetch(`${PLACES_BASE}/textsearch/json?${params}`);
  const data = (await res.json()) as TextSearchResponse;

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places Text Search error: ${data.status}`);
  }

  return {
    places: data.results || [],
    nextPageToken: data.next_page_token,
  };
}

async function getPlaceDetails(placeId: string, apiKey: string): Promise<PlaceDetails | null> {
  const params = new URLSearchParams({
    place_id: placeId,
    fields: 'place_id,name,formatted_address,formatted_phone_number,website,types',
    key: apiKey,
    language: 'es',
  });

  const res = await fetch(`${PLACES_BASE}/details/json?${params}`);
  const data = (await res.json()) as PlaceDetailsResponse;

  if (data.status !== 'OK' || !data.result) return null;
  return data.result;
}

async function batchGetDetails(placeIds: string[], apiKey: string): Promise<PlaceDetails[]> {
  const BATCH = 5;
  const results: PlaceDetails[] = [];

  for (let i = 0; i < placeIds.length; i += BATCH) {
    const batch = placeIds.slice(i, i + BATCH);
    const details = await Promise.all(batch.map((id) => getPlaceDetails(id, apiKey)));
    for (const d of details) {
      if (d) results.push(d);
    }
    if (i + BATCH < placeIds.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}

export interface ScrapeResult {
  query: string;
  found: number;
  new_prospects: number;
  skipped: number;
  enqueued: number;
  error?: string;
}

export async function scrapeQuery(
  query: string,
  env: Env,
  pageToken?: string,
): Promise<ScrapeResult> {
  const { places, nextPageToken } = await searchPlaces(
    query,
    env.GOOGLE_PLACES_KEY,
    pageToken,
  );

  const details = await batchGetDetails(
    places.map((p) => p.place_id),
    env.GOOGLE_PLACES_KEY,
  );

  const noWebsite = details.filter((d) => !d.website);

  let newProspects = 0;
  let skipped = 0;
  let enqueued = 0;

  for (const place of noWebsite) {
    const existing = await env.DB.prepare('SELECT id FROM prospects WHERE place_id = ?')
      .bind(place.place_id)
      .first<{ id: number }>();

    if (existing) {
      skipped++;
      continue;
    }

    const category = getCategory(place.types);

    await env.DB.prepare(`
      INSERT INTO prospects (place_id, name, address, phone, category, email, status)
      VALUES (?, ?, ?, ?, ?, ?, 'nuevo')
    `)
      .bind(
        place.place_id,
        place.name,
        place.formatted_address || '',
        place.formatted_phone_number || '',
        category,
        null,
      )
      .run();

    const params: ProspectParams = {
      place_id: place.place_id,
      name: place.name,
      address: place.formatted_address || '',
      phone: place.formatted_phone_number || '',
      category,
      email: null,
    };

    await env.PROSPECT_QUEUE.send(params);
    newProspects++;
    enqueued++;
  }

  void nextPageToken; // available if caller wants to paginate

  return { query, found: places.length, new_prospects: newProspects, skipped, enqueued };
}

export async function scrapeAll(env: Env): Promise<ScrapeResult[]> {
  const results: ScrapeResult[] = [];

  for (const query of SEARCH_QUERIES) {
    try {
      const result = await scrapeQuery(query, env);
      results.push(result);
      await new Promise((r) => setTimeout(r, 1000));
    } catch (e) {
      results.push({
        query,
        found: 0,
        new_prospects: 0,
        skipped: 0,
        enqueued: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}
