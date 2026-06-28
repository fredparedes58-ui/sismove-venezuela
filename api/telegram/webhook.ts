/**
 * SismoVE · Bot de Telegram (sin IA / sin costo) — menú de botones + palabras clave
 *
 * Telegram → [secret_token] → este webhook → Supabase (datos reales) → respuesta.
 * No usa modelos de pago: enruta por botones (inline keyboard) y por palabras clave.
 *
 * REGLAS (de memoria del proyecto):
 *  · Desaparecidos: cómo reportar + portales oficiales + recomendar Cruz Roja. NUNCA prometer encontrar.
 *  · "No encuentro a mi familia" → Cruz Roja 0422 799 4880 de inmediato.
 *  · Peligro inmediato → 911 / Protección Civil / Bomberos.
 *  · Solo datos reales (Supabase); si no hay, decirlo.
 *
 * Endurecido: secret_token fail-closed, rate-limit, troceo 4096, anti-inyección PostgREST,
 * ignora edited_message.
 */
export const config = { runtime: 'edge' };

const SB = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const APP_URL = 'https://sismove-venezuela.vercel.app/app';
const GEMINI = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const TG_LIMIT = 4000;
const RATE_PER_MIN = 30;

// Estadísticas (analítica anónima): solo para chats admin, definidos por env
// ADMIN_CHAT_IDS (coma-separado). SIN default → si no está configurado, nadie es
// admin (falla cerrado). NO se acepta clave por mensaje (evita filtrarla en el chat
// y un oráculo de fuerza bruta). La identidad del chat viene del payload verificado
// de Telegram (secret token), no es suplantable por el remitente.
const ADMIN_CHATS = (process.env.ADMIN_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const STAT_PAGES: [string, string][] = [
  ['home', 'Inicio (web)'], ['ayuda', 'Ayuda'], ['desap', 'Buscar'], ['ninos', 'Niños'],
  ['grupos', 'Grupos por zona'], ['refugios', 'Mapas'], ['panel', 'Panel'], ['bot', 'Bot'],
  ['info', 'Info'], ['salvo', 'Estoy a salvo'],
];

// ── Geo legible para la analítica ───────────────────────────────────────────
// Vercel da país (ISO-2), región (código ISO-3166-2, en VE = letra del estado) y ciudad.
// El municipio NO viene en las cabeceras: lo resolvemos con esta tabla de ciudades VE.
const COUNTRY: Record<string, string> = {
  VE: '🇻🇪 Venezuela', US: '🇺🇸 Estados Unidos', ES: '🇪🇸 España', CL: '🇨🇱 Chile', CO: '🇨🇴 Colombia',
  DE: '🇩🇪 Alemania', AR: '🇦🇷 Argentina', MX: '🇲🇽 México', PE: '🇵🇪 Perú', BR: '🇧🇷 Brasil', PA: '🇵🇦 Panamá',
  EC: '🇪🇨 Ecuador', IT: '🇮🇹 Italia', FR: '🇫🇷 Francia', PT: '🇵🇹 Portugal', CA: '🇨🇦 Canadá', GB: '🇬🇧 Reino Unido',
  NL: '🇳🇱 Países Bajos', CH: '🇨🇭 Suiza', UY: '🇺🇾 Uruguay', DO: '🇩🇴 Rep. Dominicana', CR: '🇨🇷 Costa Rica',
};
const VE_ESTADO: Record<string, string> = {
  A: 'Distrito Capital', B: 'Anzoátegui', C: 'Apure', D: 'Aragua', E: 'Barinas', F: 'Bolívar', G: 'Carabobo',
  H: 'Cojedes', I: 'Falcón', J: 'Guárico', K: 'Lara', L: 'Mérida', M: 'Miranda', N: 'Monagas', O: 'Nueva Esparta',
  P: 'Portuguesa', R: 'Sucre', S: 'Táchira', T: 'Trujillo', U: 'Yaracuy', V: 'Zulia', W: 'Dependencias Federales',
  X: 'La Guaira', Y: 'Delta Amacuro', Z: 'Amazonas',
};
// ciudad (normalizada, sin tildes) → [municipio, estado]
const CITY_MUNI: Record<string, [string, string]> = {
  caracas: ['Libertador', 'Distrito Capital'], petare: ['Sucre', 'Miranda'], 'los teques': ['Guaicaipuro', 'Miranda'],
  guarenas: ['Plaza', 'Miranda'], guatire: ['Zamora', 'Miranda'], charallave: ['Cristóbal Rojas', 'Miranda'],
  'ocumare del tuy': ['Tomás Lander', 'Miranda'], 'santa teresa del tuy': ['Independencia', 'Miranda'],
  'la guaira': ['Vargas', 'La Guaira'], maiquetia: ['Vargas', 'La Guaira'], 'catia la mar': ['Vargas', 'La Guaira'],
  maracaibo: ['Maracaibo', 'Zulia'], cabimas: ['Cabimas', 'Zulia'], 'ciudad ojeda': ['Lagunillas', 'Zulia'],
  valencia: ['Valencia', 'Carabobo'], 'puerto cabello': ['Puerto Cabello', 'Carabobo'], guacara: ['Guacara', 'Carabobo'],
  naguanagua: ['Naguanagua', 'Carabobo'], 'los guayos': ['Los Guayos', 'Carabobo'],
  maracay: ['Girardot', 'Aragua'], turmero: ['Santiago Mariño', 'Aragua'], cagua: ['Sucre', 'Aragua'], 'la victoria': ['José Félix Ribas', 'Aragua'],
  barquisimeto: ['Iribarren', 'Lara'], cabudare: ['Palavecino', 'Lara'], carora: ['Torres', 'Lara'],
  'san felipe': ['San Felipe', 'Yaracuy'], yaritagua: ['Peña', 'Yaracuy'], chivacoa: ['Bruzual', 'Yaracuy'], nirgua: ['Nirgua', 'Yaracuy'],
  'ciudad guayana': ['Caroní', 'Bolívar'], 'puerto ordaz': ['Caroní', 'Bolívar'], 'ciudad bolivar': ['Heres', 'Bolívar'],
  'san cristobal': ['San Cristóbal', 'Táchira'], maturin: ['Maturín', 'Monagas'], cumana: ['Sucre', 'Sucre'], carupano: ['Bermúdez', 'Sucre'],
  barcelona: ['Simón Bolívar', 'Anzoátegui'], 'puerto la cruz': ['Sotillo', 'Anzoátegui'], 'el tigre': ['Simón Rodríguez', 'Anzoátegui'],
  merida: ['Libertador', 'Mérida'], 'el vigia': ['Alberto Adriani', 'Mérida'],
  'punto fijo': ['Carirubana', 'Falcón'], coro: ['Miranda', 'Falcón'],
  acarigua: ['Páez', 'Portuguesa'], araure: ['Araure', 'Portuguesa'], guanare: ['Guanare', 'Portuguesa'],
  valera: ['Valera', 'Trujillo'], trujillo: ['Trujillo', 'Trujillo'], barinas: ['Barinas', 'Barinas'],
  porlamar: ['Mariño', 'Nueva Esparta'], 'la asuncion': ['Arismendi', 'Nueva Esparta'],
  'san juan de los morros': ['Juan Germán Roscio', 'Guárico'], calabozo: ['Francisco de Miranda', 'Guárico'], 'valle de la pascua': ['Leonardo Infante', 'Guárico'],
};
const normCity = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// Texto de ubicación de una ciudad: municipio+estado (VE) o país (extranjero).
function placeOf(city: string, pais: string | null, region: string | null): string {
  if (pais && pais !== 'VE') return (COUNTRY[pais] || `País ${pais}`).replace(/^[^\s]+\s/, '');   // país, sin emoji
  const m = CITY_MUNI[normCity(city)];
  if (m) return `Mun. ${m[0]}, ${m[1]}`;
  const est = region ? VE_ESTADO[region] : null;
  return est ? `Edo. ${est}` : 'Venezuela';
}

// Reglas estrictas para la conversación con IA (Gemini). Las rutas críticas
// (emergencias, familia, búsqueda de personas) NO usan IA: son deterministas.
const SYSTEM_PROMPT =
`Eres el asistente de SismoVE, plataforma ciudadana ante el terremoto de Venezuela (doblete M7.2 + M7.5, Yaracuy, 24-jun-2026). Hablas español, con tono claro, breve y empático.
REGLAS ESTRICTAS (obligatorias):
1) NUNCA prometas encontrar a una persona ni garantices datos; los registros solo ayudan a difundir.
2) Si alguien busca a un familiar: recomienda la Cruz Roja 0422 799 4880 y los portales; dile que escriba el nombre o cédula para buscar en los registros.
3) Ante peligro inmediato (atrapados, heridos graves, fuga de gas, incendio): indica llamar YA al 911 o Protección Civil 0800-724-8451.
4) Usa SOLO los datos del "Contexto real" que se te entregue. Si no tienes el dato, dilo; NUNCA inventes nombres, cifras, direcciones ni teléfonos.
5) No des diagnósticos médicos ni asesoría legal/financiera.
6) Sé conciso (máximo ~6 líneas). No uses Markdown complejo.`;

/* ─── Textos oficiales (verificados) ──────────────────────────────────────── */
const EMERG_TEXT =
`☎ EMERGENCIAS — si hay peligro inmediato, llama YA:
• Nacional: 911
• Protección Civil Nacional: 0800-724-8451 (0800-PCIVIL-1)
• Caracas: Protección Civil 0212-575-1829 · Bomberos 0212-545-4545
• Valencia: Protección Civil 0241-859-3969 / 0412-827-4252 · Bomberos 0414-433-3952`;

const FAMILIA_TEXT =
`🤝 Para reencontrar a tu familia:
• Cruz Roja Venezolana — Restablecimiento del Contacto entre Familiares: 0422 799 4880
• Registra o busca el caso en: venezuelatebusca.com · desaparecidosterremotovenezuela.com

Escríbeme el nombre o la cédula y busco en los registros.
Nota: estos registros ayudan a difundir; no garantizan localizar a la persona.`;

const COMO_REPORTAR =
`📝 Cómo registrar a una persona desaparecida:
1) Entra a venezuelatebusca.com o desaparecidosterremotovenezuela.com
2) Completa: nombre, cédula, edad, foto reciente y zona donde se le vio
3) Comparte el enlace del caso
4) Llama a la Cruz Roja: 0422 799 4880`;

const BUSCAR_PROMPT = '🔍 Escríbeme el nombre o la cédula de la persona (ej: María Pérez, o 12345678).';
const PORTALES = 'venezuelatebusca.com · desaparecidosterremotovenezuela.com';
const CRUZ_ROJA = 'Cruz Roja: 0422 799 4880';

const MENU_KB = {
  inline_keyboard: [
    [{ text: '🔍 Buscar persona', callback_data: 'buscar' }],
    [{ text: '📦 Centros de acopio', callback_data: 'acopio' }],
    [{ text: '📊 Estado / novedades', callback_data: 'estado' }],
    [{ text: '☎ Emergencias', callback_data: 'emergencias' }],
    [{ text: '🤝 No encuentro a mi familia', callback_data: 'familia' }],
    [{ text: '🗺️ Abrir mapas (app)', url: APP_URL }],
  ],
};
const WELCOME =
`👋 Soy el asistente de SismoVE (terremoto en Venezuela).
Toca una opción o escríbeme tu situación con tus palabras:`;

/* ─── Comparación en tiempo constante ─────────────────────────────────────── */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < bb.length; i++) diff |= (ab[i] ?? 0) ^ bb[i];
  return diff === 0;
}

/* ─── Handler ─────────────────────────────────────────────────────────────── */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('ok');
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return new Response('misconfigured', { status: 500 });
  const got = req.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!timingSafeEqual(got, secret)) return new Response('forbidden', { status: 403 });

  let update: any;
  try { update = await req.json(); } catch { return new Response('ok'); }

  try {
    // Botones del menú (callback_query)
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      await answerCallback(cq.id);
      if (chatId) await handleAction(chatId, cq.data || '');
      return new Response('ok');
    }

    const msg = update.message;               // ignoramos edited_message
    const chatId = msg?.chat?.id;
    const text = (msg?.text || '').trim();
    if (!chatId || !text) return new Response('ok');

    if (text.startsWith('/start')) { await subscribe(chatId, msg.chat?.username); await sendMenu(chatId, WELCOME); return new Response('ok'); }
    if (text.startsWith('/stop'))  { await unsubscribe(chatId); await send(chatId, 'Listo, no recibirás más avisos. Escribe /start para volver.'); return new Response('ok'); }
    if (text.startsWith('/ayuda') || text.startsWith('/menu') || text.startsWith('/help')) { await sendMenu(chatId, WELCOME); return new Response('ok'); }
    if (text.startsWith('/estado') || text.startsWith('/status') || text.startsWith('/novedades')) { await send(chatId, await estadoText()); return new Response('ok'); }
    if (/^\/(estad[íi]stica[s]?|anal[íi]tica|analytics|stats)(@\w+)?$/i.test(text.split(/\s+/)[0])) {
      if (!isAdminChat(chatId)) { await send(chatId, '🔒 Las estadísticas de uso son solo para administradores.'); return new Response('ok'); }
      await send(chatId, await analiticaText());
      return new Response('ok');
    }

    if (await rateLimited(chatId)) {
      await send(chatId, 'Estás enviando muchos mensajes muy rápido 🙏. Espera un momento. Si es una emergencia, llama al 911.');
      return new Response('ok');
    }
    await saveMsg(chatId, text);
    await routeText(chatId, text);
  } catch (e: any) {
    console.error('bot error', e?.message);
  }
  return new Response('ok');
}

/* ─── Enrutado por palabras clave ─────────────────────────────────────────── */
async function routeText(chatId: string, text: string) {
  const t = text.toLowerCase();
  if (/atrapad|derrumb|herid|sangr|fuego|incendi|fuga de gas|huele a gas|no respira|inconsci|emergencia|auxilio/.test(t))
    return send(chatId, EMERG_TEXT);
  if (/no encuentro|no localizo|no s[eé] (nada|d[oó]nde)|no me (puedo )?comunic|incomunicad|perd[ií] a mi|mi familia|mi hij|mi madre|mi padre|mi esposa|mi esposo|mi hermano|mi hermana|reencontr/.test(t))
    return send(chatId, FAMILIA_TEXT);
  if (/^\/?acopio|acopio|donar|donaci[oó]n|v[ií]veres|quiero ayudar|d[oó]nde llevo|centro de/.test(t)) {
    const zona = t.replace(/.*?(acopio|donar|donaci[oó]n|v[ií]veres|centro de)\s*/, '').trim();
    return send(chatId, await acopioText(zona));
  }
  if (/c[oó]mo reportar|registrar (a|una)|reportar desaparec/.test(t)) return send(chatId, COMO_REPORTAR);
  if (/^(hola|buenas|hey|men[uú]|inicio|ayuda)\b/.test(t)) return sendMenu(chatId, WELCOME);
  // Preguntas de cantidad/conteo → cifras reales (estado)
  if (/\b(cu[aá]nt\w*|cantidad|cu[aá]ntos hay|n[uú]mero de|total de|cifras?|estad[ií]sticas?|balance)\b/i.test(t)) return send(chatId, await estadoText());
  // ¿parece búsqueda de persona (nombre corto o cédula) o pregunta/conversación?
  const looksQuestion = /\?|\b(qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|por\s?qu[eé]|cu[aá]l|puedo|debo|hago|inform|explica|dime|recomienda|necesito|hay|deber[ií]a|servicio|pasa|funciona|sirve)\b/i.test(t);
  const words = text.trim().split(/\s+/).length;
  const looksPerson = /^\d{5,9}$/.test(text.trim()) || (words <= 3 && !looksQuestion);
  if (looksPerson) return send(chatId, await searchText(text));   // factual, sin IA
  return send(chatId, await geminiReply(chatId, text));           // conversación coherente (Gemini)
}

/* ─── Conversación coherente con Gemini (gratis), GROUNDED + reglas ───────── */
async function groundingText(): Promise<string> {
  let h = -1, c = -1, d = -1;
  try { [h, c, d] = await Promise.all([cnt('hospital_admisiones'), cnt('centros_acopio_external'), cnt('desaparecidos_external')]); } catch {}
  const n = (x: number) => x < 0 ? 'n/d' : String(x);
  return `Evento: doblete sísmico M7.2 + M7.5 (Yaracuy, 24-jun-2026). Estados más afectados: La Guaira (zona de desastre), Caracas, Miranda, Aragua, Carabobo, Falcón, Yaracuy.
Datos actuales en SismoVE: ingresos hospitalarios=${n(h)}, centros de acopio=${n(c)}, personas reportadas=${n(d)}.
Contactos reales: Cruz Roja (reencuentro familiar) 0422 799 4880; Emergencias 911; Protección Civil 0800-724-8451.
Portales para registrar/buscar personas: venezuelatebusca.com, desaparecidosterremotovenezuela.com. Centros de acopio: centro-de-acopio-ven.vercel.app.
Mapas en vivo y buscador: ${APP_URL}.`;
}
async function geminiReply(chatId: string, userText: string): Promise<string> {
  if (!GEMINI) return searchText(userText);   // sin key → respaldo factual
  try {
    let hist: any[] = [];
    try { hist = await sb(`telegram_messages?chat_id=eq.${chatId}&select=role,content&order=created_at.desc&limit=8`); } catch {}
    const contents: any[] = [];
    (Array.isArray(hist) ? hist : []).reverse().forEach(m => {
      const txt = String(m?.content || '').slice(0, 500);
      if (txt) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: txt }] });
    });
    const ground = await groundingText();
    contents.push({ role: 'user', parts: [{ text: `Contexto real (úsalo, no inventes nada fuera de esto):\n${ground}\n\nMensaje del usuario: ${userText}` }] });
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
    let txt = '';
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ system_instruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents, generationConfig: { temperature: 0.4, maxOutputTokens: 500 } }),
      });
      if (res.ok) { const j: any = await res.json(); txt = (j?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('').trim(); }
    } finally { clearTimeout(t); }
    if (!txt) return searchText(userText);
    await saveMsg(chatId, txt, 'assistant');
    return txt;
  } catch { return searchText(userText); }
}

async function handleAction(chatId: string, data: string) {
  if (data === 'buscar') return send(chatId, BUSCAR_PROMPT);
  if (data === 'acopio') return send(chatId, await acopioText(''));
  if (data === 'estado') return send(chatId, await estadoText());
  if (data === 'emergencias') return send(chatId, EMERG_TEXT);
  if (data === 'familia') return send(chatId, FAMILIA_TEXT);
  return sendMenu(chatId, WELCOME);
}

/* ─── Estado / novedades (incluye "sin cambios") ──────────────────────────── */
async function cnt(table: string): Promise<number> {
  try {
    // HEAD + count=exact: no depende de columna 'id' (las _external usan external_id).
    const r = await fetch(`${SB}/rest/v1/${table}`, { method: 'HEAD', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'count=exact', Range: '0-0' } });
    const n = parseInt((r.headers.get('content-range') || '').split('/')[1] || '', 10);
    return Number.isFinite(n) ? n : -1;
  } catch { return -1; }
}
async function estadoText(): Promise<string> {
  const [h, d, c, z] = await Promise.all([cnt('hospital_admisiones'), cnt('desaparecidos_external'), cnt('centros_acopio_external'), cnt('zona_reports')]);
  let when = 'hace pocos minutos';
  try {
    const last = await sb(`sync_runs?ok=eq.true&order=ran_at.desc&limit=1`);
    if (last?.[0]?.ran_at) when = new Date(last[0].ran_at).toLocaleString('es-VE', { timeZone: 'America/Caracas' });
  } catch {}
  const n = (x: number) => x < 0 ? '—' : x.toLocaleString('es');
  return `📊 Estado de SismoVE\nRevisión automática cada ~10 min · última: ${when}\n\n• 🏥 Ingresos hospitalarios: ${n(h)}\n• 🔍 Personas reportadas: ${n(d)}\n• 📦 Centros de acopio: ${n(c)}\n• ⚠️ Zonas afectadas reportadas: ${n(z)}\n\nSi estos números no cambiaron desde tu último aviso, es que no ha entrado información nueva. Te aviso en automático en cuanto algo cambie. Escribe /estado cuando quieras revisar.`;
}

/* ─── Estadísticas de uso (analítica anónima, solo admin) ─────────────────── */
function isAdminChat(chatId: any): boolean {
  return ADMIN_CHATS.includes(String(chatId));
}
async function countEvents(q: string): Promise<number> {
  try {
    const r = await fetch(`${SB}/rest/v1/analytics_events?${q}`, { method: 'HEAD', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'count=exact', Range: '0-0' } });
    return parseInt((r.headers.get('content-range') || '').split('/')[1] || '0', 10) || 0;
  } catch { return 0; }
}
async function analiticaText(): Promise<string> {
  // "hoy" = desde la medianoche en Caracas (UTC-4), expresada en UTC (00:00 Caracas = 04:00Z).
  const today = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10) + 'T04:00:00Z';
  const enc = encodeURIComponent(today);
  const [visit, visitHoy, vistas, vistasHoy, busq, rep, botEv] = await Promise.all([
    countEvents('ev=eq.visit&select=id'),
    countEvents(`ev=eq.visit&ts=gte.${enc}&select=id`),
    countEvents('ev=eq.view&select=id'),
    countEvents(`ev=eq.view&ts=gte.${enc}&select=id`),
    countEvents('ev=eq.search&select=id'),
    countEvents('ev=eq.report&select=id'),
    countEvents('ev=eq.bot&select=id'),
  ]);
  const pares = await Promise.all(STAT_PAGES.map(async ([k, l]) => [l, await countEvents(`ev=eq.view&page=eq.${k}&select=id`)] as [string, number]));
  const f = (n: number) => n.toLocaleString('es');
  const pct = (a: number, b: number) => b > 0 ? Math.round((a * 100) / b) + '%' : '—';
  const per = (a: number, b: number) => b > 0 ? (a / b).toFixed(1) : '—';
  const visibles = pares.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

  let out = `📈 ANALÍTICA DE SISMOVE\n(anónima · sin datos personales · solo conteos agregados)\n`;
  out += `🗓️ Periodo: todo el histórico · "hoy" = desde medianoche (Caracas)\n`;
  out += `\n──────────\n👥 AUDIENCIA\n`;
  out += `• Visitantes únicos: ${f(visit)}  (hoy: ${f(visitHoy)})\n   ↳ personas distintas por sesión, no recargas\n`;
  out += `• Vistas de página: ${f(vistas)}  (hoy: ${f(vistasHoy)})\n   ↳ pantallas abiertas en total\n`;
  out += `• Profundidad: ${per(vistas, visit)} vistas por visitante\n   ↳ cuánto exploran de media (más alto = más interés)\n`;

  out += `\n──────────\n🔧 INTERACCIONES\n`;
  out += `• 🔎 Búsquedas de personas: ${f(busq)}  (${per(busq, visit)} por visitante)\n`;
  out += `• 📝 Reportes creados (mapa/desaparecidos): ${f(rep)}\n`;
  out += `• 🤖 Bot abierto: ${f(botEv)}  (${pct(botEv, visit)} de los visitantes)\n`;

  out += `\n──────────\n📊 SECCIONES MÁS VISTAS\n(% sobre el total de vistas)\n`;
  out += visibles.length ? visibles.map(([l, v]) => `• ${l}: ${f(v)} · ${pct(v, vistas)}`).join('\n') : 'Aún sin datos.';

  // Origen + geografía (agregado sobre ev=visit; ubicación aproximada por IP)
  try {
    const rows = await fetch(`${SB}/rest/v1/analytics_events?ev=eq.visit&select=ref,pais,region,ciudad&order=ts.desc&limit=20000`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }).then(r => r.ok ? r.json() : []);
    const list = Array.isArray(rows) ? rows : [];
    const sample = list.length || 1;
    const tally = (key: string, def?: string) => { const m: Record<string, number> = {}; for (const r of list) { const v = r[key] || def; if (v) m[v] = (m[v] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
    const refTip: Record<string, string> = { directo: 'escriben la URL o la tienen guardada', interno: 'navegando dentro del sitio', whatsapp: 'compartido por WhatsApp', instagram: 'desde Instagram', telegram: 'desde Telegram', twitter: 'desde X/Twitter', facebook: 'desde Facebook', google: 'desde búsqueda en Google' };
    const fu = tally('ref', 'directo').slice(0, 8), pa = tally('pais').slice(0, 8);
    // Ciudades: agrupar por ciudad, resolviendo país/estado dominante para el municipio
    const cityAgg: Record<string, { count: number; pais: Record<string, number>; region: Record<string, number> }> = {};
    for (const r of list) { const c = r.ciudad; if (!c) continue; const a = cityAgg[c] || (cityAgg[c] = { count: 0, pais: {}, region: {} }); a.count++; if (r.pais) a.pais[r.pais] = (a.pais[r.pais] || 0) + 1; if (r.region) a.region[r.region] = (a.region[r.region] || 0) + 1; }
    const topKey = (m: Record<string, number>) => Object.entries(m).sort((x, y) => y[1] - x[1])[0]?.[0] || null;
    const ci = Object.entries(cityAgg).map(([c, a]) => ({ ciudad: c, count: a.count, pais: topKey(a.pais), region: topKey(a.region) })).sort((a, b) => b.count - a.count).slice(0, 8);

    if (fu.length) out += `\n\n──────────\n🔗 CÓMO LLEGAN (fuente del tráfico)\n` + fu.map(([k, v]) => `• ${k}: ${f(v)} · ${pct(v, sample)}${refTip[k] ? `\n   ↳ ${refTip[k]}` : ''}`).join('\n');
    if (pa.length) out += `\n\n──────────\n🌎 PAÍSES\n` + pa.map(([k, v]) => `• ${COUNTRY[k] || k} (${k}): ${f(v)} · ${pct(v, sample)}`).join('\n');
    if (ci.length) out += `\n\n──────────\n🏙️ CIUDADES (con municipio)\n` + ci.map(c => `• ${c.ciudad} — ${placeOf(c.ciudad, c.pais, c.region)}: ${f(c.count)}`).join('\n');
  } catch { /* sin datos de origen */ }

  out += `\n\n──────────\nℹ️ La ubicación es aproximada (por IP, a nivel de ciudad): no es GPS ni identifica a nadie. El municipio se deduce de la ciudad para las principales urbes de Venezuela.\n`;
  out += `\n🕒 Actualizado: ${ahora} (Caracas)\nEscribe /estadisticas cuando quieras revisar.`;
  return out;
}

/* ─── Acciones con datos reales (Supabase) ────────────────────────────────── */
async function searchText(query: string): Promise<string> {
  const clean = String(query || '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().slice(0, 40);
  if (!clean) return BUSCAR_PROMPT;
  const q = encodeURIComponent(`*${clean}*`);
  let hosp: any[] = [], desap: any[] = [];
  // Misma data que la web: ingresos hospitalarios (OCR) + portales de desaparecidos. NO se muestra cédula.
  try { hosp = await sb(`hospital_admisiones?select=nombre,hospital&nombre=ilike.${q}&limit=8`); } catch {}
  try { desap = await sb(`desaparecidos_reportes?select=nombre,zona,estado,contacto&nombre=ilike.${q}&limit=6`); } catch {}
  if (!hosp.length && !desap.length)
    return `No encontré a "${clean}" en los listados.\n• Busca rescatados/encontrados en: afectadosporelterremotovenezuela.com\n• Regístralo en: ${PORTALES}\n• Contacta a la ${CRUZ_ROJA}\nEstos registros ayudan a difundir; no garantizan localizar a la persona.`;
  let out = `Resultados para "${clean}":\n`;
  if (hosp.length) out += `\n🏥 Ingresos a hospitales:\n${hosp.map(r => `• ${r.nombre}${r.hospital ? ' — ' + r.hospital : ''}`).join('\n')}\n`;
  if (desap.length) out += `\n🔍 Reportados como desaparecidos:\n${desap.map(r => `• ${r.nombre}${r.zona ? ' — ' + r.zona : ''}${r.estado === 'encontrado' ? ' — encontrado' : ''}${r.contacto ? ' · 📞 ' + r.contacto : ''}`).join('\n')}\n`;
  out += `\n🔎 Busca también rescatados/encontrados en: afectadosporelterremotovenezuela.com`;
  out += `\nNota: provienen de listados de difusión; no es verificación propia. Para una búsqueda formal contacta a la ${CRUZ_ROJA}.`;
  return out;
}

async function acopioText(zona: string): Promise<string> {
  let rows: any[] = [];
  try { rows = await sb(`centros_acopio_external?select=nombre,direccion,telefono,necesita&limit=60`); } catch {}
  const z = (zona || '').toLowerCase().trim();
  if (z) rows = rows.filter(r => `${r.nombre} ${r.direccion || ''}`.toLowerCase().includes(z));
  rows = rows.slice(0, 8);
  if (!rows.length) return `No tengo centros${z ? ' en "' + zona + '"' : ''}. Portal oficial: centro-de-acopio-ven.vercel.app · o abre los mapas: ${APP_URL}`;
  const lista = rows.map(r => `📦 ${r.nombre}${r.direccion ? ' — ' + r.direccion : ''}${r.telefono ? ' ☎ ' + r.telefono : ''}${(r.necesita || []).length ? '\n   Necesita: ' + (r.necesita as any[]).slice(0, 6).join(', ') : ''}`).join('\n\n');
  return `Centros de acopio${z ? ' en "' + zona + '"' : ''}:\n\n${lista}\n\nMapa completo: ${APP_URL}`;
}

/* ─── Supabase + Telegram ─────────────────────────────────────────────────── */
async function sb(path: string, init?: RequestInit) {
  const res = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`sb ${res.status}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}
async function rateLimited(chatId: string): Promise<boolean> {
  const since = new Date(Date.now() - 60000).toISOString();
  try {
    const res = await fetch(
      `${SB}/rest/v1/telegram_messages?chat_id=eq.${chatId}&role=eq.user&created_at=gte.${since}&select=id`,
      { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'count=exact', Range: '0-0' } },
    );
    const n = parseInt((res.headers.get('content-range') || '').split('/')[1] || '0', 10);
    return n >= RATE_PER_MIN;
  } catch { return false; }
}
async function send(chatId: string, text: string) {
  for (const part of chunkText(String(text || '').trim() || '(sin contenido)', TG_LIMIT)) {
    const res = await fetch(`${TG}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: part, disable_web_page_preview: true }),
    });
    if (!res.ok) console.error('telegram send', res.status, (await res.text()).slice(0, 150));
  }
}
async function sendMenu(chatId: string, text: string) {
  const res = await fetch(`${TG}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: MENU_KB, disable_web_page_preview: true }),
  });
  if (!res.ok) console.error('telegram menu', res.status, (await res.text()).slice(0, 150));
}
async function answerCallback(id: string) {
  await fetch(`${TG}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id }),
  }).catch(() => {});
}
function chunkText(s: string, n: number): string[] {
  if (s.length <= n) return [s];
  const out: string[] = []; let cur = '';
  for (const line of s.split('\n')) {
    if ((cur ? cur.length + 1 : 0) + line.length > n) {
      if (cur) { out.push(cur); cur = ''; }
      if (line.length > n) { for (let i = 0; i < line.length; i += n) out.push(line.slice(i, i + n)); }
      else cur = line;
    } else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}
async function subscribe(chatId: string, username?: string) {
  await sb('bot_subscribers', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ chat_id: String(chatId), username: username ?? null, unsubscribed_at: null }]) }).catch(() => {});
}
async function unsubscribe(chatId: string) {
  await sb(`bot_subscribers?chat_id=eq.${chatId}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ unsubscribed_at: new Date().toISOString() }) }).catch(() => {});
}
async function saveMsg(chatId: string, content: string, role: string = 'user') {
  await sb('telegram_messages', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ chat_id: String(chatId), role, content }]) }).catch(() => {});
}
