/**
 * AimHarder Scraper Service — v2
 *
 * Estrategia:
 *  1. Login en AimHarder
 *  2. Navegar a /schedule?adm y hacer clic en el día correcto del calendario
 *  3. Interceptar respuestas AJAX/JSON (estrategia principal)
 *  4. Si no hay JSON útil, parsear el HTML con cheerio
 *
 * DEBUG: En cada ejecución guarda capturas y HTML en tempus-backend/debug/
 * Si algo falla, mira esas carpetas para ver qué está viendo Playwright.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const https = require('https');
const Center = require('../models/Center');
const AimHarderIntegration = require('../models/AimHarderIntegration');
const ActiveClient = require('../models/ActiveClient');
const AimHarderClientMonthlySnapshot = require('../models/AimHarderClientMonthlySnapshot');
const AttendanceAbsenceSnapshot = require('../models/AttendanceAbsenceSnapshot');
const CenterOccupancySnapshot = require('../models/CenterOccupancySnapshot');
const ClassReport = require('../models/ClassReport');
const ClassReportRoster = require('../models/ClassReportRoster');

// URL del portal principal de AimHarder (donde está el botón de login)
const LOGIN_URL = 'https://aimharder.com';
// URL directa del servicio de autenticación
const AUTH_URL = 'https://login.aimharder.com';
const API_BASE_URL = 'https://api.aimharder.com';
const DEBUG_DIR = path.join(__dirname, '../../debug');
const PLAYWRIGHT_DEBUG = false;
const METRICS_DEBUG = String(process.env.AIMHARDER_METRICS_DEBUG || '').toLowerCase() === 'true';

// ── Asegurarse de que el directorio de debug existe ──
if (PLAYWRIGHT_DEBUG && !fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// Cache de sesión por centro (cookies de AimHarder, no de Tempus)
// La fuente de verdad es MongoDB Atlas (persistente en Railway).
// La memoria actúa como cache L1 para evitar round-trips a DB en cada petición.
const sessionCacheByCenter = new Map();
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 horas
const apiTokenCacheByCenter = new Map();

async function loadSessionFromDB(config) {
  if (!config.integrationId) return null;
  try {
    const integration = await AimHarderIntegration.findById(config.integrationId)
      .select('+sessionCookies +sessionExpiresAt')
      .lean();
    if (!integration || !integration.sessionCookies || !integration.sessionExpiresAt) return null;
    if (Date.now() >= new Date(integration.sessionExpiresAt).getTime()) return null;
    return { cookies: integration.sessionCookies, expiry: new Date(integration.sessionExpiresAt).getTime() };
  } catch {
    return null;
  }
}

async function saveSessionToDB(config, value) {
  if (!config.integrationId) return;
  try {
    await AimHarderIntegration.findByIdAndUpdate(config.integrationId, {
      $set: {
        sessionCookies: value.cookies,
        sessionExpiresAt: new Date(value.expiry),
      },
    });
  } catch (e) {
    console.warn('[AimHarder] No se pudo guardar sesión en MongoDB:', e.message);
  }
}

async function deleteSessionFromDB(config) {
  if (!config.integrationId) return;
  try {
    await AimHarderIntegration.findByIdAndUpdate(config.integrationId, {
      $set: { sessionCookies: null, sessionExpiresAt: null },
    });
  } catch { /* ignorar */ }
}

// ─────────────────────────────────────────────────────
// Helpers de fecha
// ─────────────────────────────────────────────────────

function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

function toAimHarderDayKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
}

function addDays(date, amount) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

function toDateInputValue(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

const SPANISH_MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

// Comprueba, leyendo directamente el DOM, si el horario mostrado corresponde
// de verdad al día objetivo. Nunca nos fiamos de que un clic "haya funcionado":
// mostrar/guardar el día equivocado es peor que fallar con un error explícito.
async function isOnTargetDay(page, targetDate) {
  const info = await resolverListadoDelDia(page, targetDate);
  return Boolean(info && info.encontrado);
}

// Devuelve el TROZO de HTML que corresponde de verdad al día pedido.
//
// Por qué existe: `document.querySelector('#clasesDiaSel .titRvClass')` devuelve
// SIEMPRE el primer título del documento. Si AimHarder mantiene en el DOM el
// listado de varios días (por eso el título "no se repintaba" y por eso cambiar
// de día no dispara ninguna petición), mirar solo el primero hace dos cosas
// malas a la vez: creer que seguimos en el día de hoy, y parsear `.bloqueClase`
// de TODO el documento, o sea las clases del día equivocado.
//
// Aquí se recorren TODOS los `.titRvClass`, se parsea la fecha de cada uno y se
// devuelve el contenedor cuyo título coincide exactamente con el día pedido.
// Eso es una prueba real de que estamos leyendo ese día, no una suposición.
function collapseSpaces(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeBasicHtmlEntities(value = '') {
  // /api/coachBookings devuelve "Run &amp; Sweat": los nombres vienen escapados.
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

// Hora de clase en formato "HH:MM". Acepta "07:00", "7:00" o "07:00 - 08:00"
// (se queda con la hora de inicio). Las claves de clases guardadas se comparan
// con esto, así que da igual con qué formato se guardaran en su día.
function normalizeClassTime(value = '') {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return String(value || '').trim();
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

// AimHarder manda el color de los avisos como "r,g,b" (p. ej. "242,36,70").
function alertColorFromRgb(value = '') {
  const parts = String(value || '').split(',').map((v) => Number(v.trim()));
  if (parts.length !== 3 || parts.some((v) => Number.isNaN(v))) return 'neutral';
  const [r, g, b] = parts;
  if (b > r && b > g) return 'blue';
  if (r > 150 && g < 120) return 'red';
  return 'neutral';
}

// Un atleta cuenta como apuntado si bookState=1 y NO tiene cancelDay.
// Comprobado contra el propio `ocupationr` de AimHarder en las 90 clases de
// dos días distintos: cuadra en todas. (bookState=1 con cancelDay = cancelación
// que aún figura en la lista; bookState=0 = baja.)
function isBookedAthlete(athlete) {
  return Boolean(athlete) && Number(athlete.bookState) === 1 && !athlete.cancelDay;
}

// Clases del día, en el mismo formato que devolvía el parseo del HTML, pero a
// partir del JSON de /api/coachBookings (la fuente real: es lo que AimHarder
// pinta en pantalla). Se excluyen las clases "Open" (sin coach, no se anotan).
function parseCoachBookingsJson(json) {
  const bookings = Array.isArray(json && json.bookings) ? json.bookings : [];
  const classes = [];

  for (const booking of bookings) {
    const className = decodeBasicHtmlEntities(collapseSpaces(booking.className || booking.classNameOrig));
    const classTime = normalizeClassTime(booking.startTime || booking.time);
    const instructorName = decodeBasicHtmlEntities(collapseSpaces(booking.coachName));
    if (!className || !classTime || !instructorName) continue;
    if (/open/i.test(className)) continue;

    const members = [];
    for (const athlete of Array.isArray(booking.athletes) ? booking.athletes : []) {
      if (!isBookedAthlete(athlete)) continue;
      const memberName = decodeBasicHtmlEntities(collapseSpaces(athlete.name || athlete.realName || athlete.nickname));
      if (!memberName || members.some((m) => m.memberName === memberName)) continue;

      const alerts = [];
      for (const [msg, color] of [[athlete.alertmsg, athlete.alertcolor], [athlete.alertmsg2, athlete.alertcolor2]]) {
        const text = decodeBasicHtmlEntities(collapseSpaces(msg));
        if (!text || alerts.some((a) => a.text === text)) continue;
        alerts.push({ text, color: alertColorFromRgb(color) });
      }
      members.push({ memberName, alerts });
    }

    classes.push({
      className,
      classTime,
      instructorName,
      period: getPeriodByTime(classTime),
      members,
    });
  }

  return classes.sort((a, b) => a.classTime.localeCompare(b.classTime));
}

// Ocupación del día a partir del mismo JSON, con la forma que ya consume
// storeOccupancy. Aquí sí entran todas las clases (también las Open).
function occupancyFromCoachBookings(json) {
  const bookings = Array.isArray(json && json.bookings) ? json.bookings : [];
  const classes = [];

  for (const booking of bookings) {
    const className = decodeBasicHtmlEntities(collapseSpaces(booking.className || booking.classNameOrig));
    const classTime = normalizeClassTime(booking.startTime || booking.time);
    if (!className && !classTime) continue;

    const capacity = Number(booking.limit) || 0;
    const bookedCount = Number(booking.ocupationr) || 0;
    let attendanceCount = Number(booking.attendance) || 0;
    if (attendanceCount > bookedCount && bookedCount > 0) attendanceCount = bookedCount;
    const noShowCount = Math.max(bookedCount - attendanceCount, 0);
    const waitlistCount = Math.max(Number(booking.waitlist) || 0, 0);

    classes.push({
      className,
      classTime,
      instructorName: decodeBasicHtmlEntities(collapseSpaces(booking.coachName)),
      roomName: decodeBasicHtmlEntities(collapseSpaces(booking.salaname)),
      bookedCount,
      attendanceCount,
      noShowCount,
      waitlistCount,
      waitlistMembers: [],
      capacity,
      occupancyRate: formatPercent(bookedCount, capacity),
      attendanceRate: formatPercent(attendanceCount, capacity),
    });
  }

  return classes.sort((a, b) => a.classTime.localeCompare(b.classTime));
}

// Pide el día directamente a la API que usa el propio AimHarder.
//
// Descubierto leyendo el código fuente de `window.weekSelDay` en producción:
//
//   currCallBook = $.ajax({ type: "GET", url: "/api/coachBookings",
//     data: { day: fSel, familyId: idFamiliar, showCurrent: showCurrentClassesSend, ... } })
//
// Es decir: cambiar de día NO recarga la página ni navega; hace esta llamada y
// repinta. Por eso ninguna estrategia de clic funcionaba y por eso el título
// seguía siendo el de hoy. Aquí se reproduce la llamada desde dentro de la
// página (misma sesión y mismas cookies) y se devuelve su HTML, que es
// EXACTAMENTE el listado del día pedido: lo garantiza el parámetro `day`.
async function pedirDiaAApiCoachBookings(page, targetDate) {
  const dayKey = toAimHarderDayKey(targetDate);

  const respuesta = await page.evaluate(async (day) => {
    const num = (valor, porDefecto) => (typeof valor === 'number' || typeof valor === 'string' ? valor : porDefecto);
    // Se copian los mismos valores que usa la página para que la respuesta
    // tenga la misma forma que la que ya sabemos parsear.
    const params = new URLSearchParams({
      day: String(day),
      familyId: typeof window.idFamiliar === 'string' ? window.idFamiliar : '',
      showCurrent: String(num(window.showCurrentClassesSend, 1)),
      showCurrentPrev: String(num(window.showCurrentPrevSend, 2)),
      showCurrentNext: String(num(window.showCurrentNextSend, 2)),
      _: String(Date.now()),
    });
    try {
      const r = await fetch(`/api/coachBookings?${params.toString()}`, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      const texto = await r.text();
      return { ok: r.ok, status: r.status, url: `/api/coachBookings?${params.toString()}`, body: texto.slice(0, 3000000) };
    } catch (e) {
      return { ok: false, status: 0, url: `/api/coachBookings?${params.toString()}`, body: '', error: String(e && e.message ? e.message : e) };
    }
  }, dayKey).catch((e) => ({ ok: false, status: 0, body: '', error: e.message }));

  if (!respuesta || !respuesta.ok || !respuesta.body) {
    return { ok: false, detalle: `status=${respuesta && respuesta.status} error=${respuesta && respuesta.error} url=${respuesta && respuesta.url}` };
  }

  // Comprobado en producción: la respuesta es JSON con la forma
  //   { resmsgs, birthdays, timetable, seminars, bookings[], day, dayYYYYMMDD }
  // y cada booking trae coachName, className, startTime, limit, ocupationr,
  // attendance y athletes[] (name, bookState, cancelDay, alertmsg, ...).
  // `dayYYYYMMDD` es la prueba de que es el día pedido.
  const crudo = respuesta.body.trim();
  let html = null;
  if (crudo.startsWith('{') || crudo.startsWith('[')) {
    try {
      const datos = JSON.parse(crudo);
      if (datos && Array.isArray(datos.bookings)) {
        const diaDevuelto = String(datos.dayYYYYMMDD || '');
        if (diaDevuelto !== String(dayKey)) {
          return { ok: false, detalle: `La API devolvió el día ${diaDevuelto || '?'} en vez de ${dayKey}` };
        }
        return { ok: true, json: datos, url: respuesta.url };
      }
      const buscarHtml = (valor, profundidad = 0) => {
        if (profundidad > 6 || valor == null) return null;
        if (typeof valor === 'string') return valor.includes('bloqueClase') ? valor : null;
        if (Array.isArray(valor)) {
          for (const hijo of valor) {
            const hallado = buscarHtml(hijo, profundidad + 1);
            if (hallado) return hallado;
          }
          return null;
        }
        if (typeof valor === 'object') {
          for (const hijo of Object.values(valor)) {
            const hallado = buscarHtml(hijo, profundidad + 1);
            if (hallado) return hallado;
          }
        }
        return null;
      };
      html = buscarHtml(datos);
      if (!html) {
        return {
          ok: false,
          detalle: `La respuesta es JSON pero no trae HTML con clases. Claves: ${JSON.stringify(Object.keys(datos || {})).slice(0, 300)}. Muestra: ${crudo.slice(0, 300)}`,
        };
      }
    } catch (e) {
      return { ok: false, detalle: `JSON ilegible: ${e.message}. Muestra: ${crudo.slice(0, 300)}` };
    }
  } else {
    html = crudo;
  }

  if (!html.includes('bloqueClase')) {
    return { ok: false, detalle: `La respuesta no contiene ninguna clase (${html.length} caracteres). Muestra: ${html.slice(0, 300)}` };
  }

  return { ok: true, html, url: respuesta.url };
}

// Recorta un HTML al listado del día pedido. Si trae varios días (el endpoint
// admite `showCurrentPrev`/`showCurrentNext`), se queda solo con el que toca.
function acotarHtmlAlDia(html, targetDate) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const titulos = $('.titRvClass').toArray();
  if (titulos.length <= 1) return html;

  const dia = targetDate.getDate();
  const mes = normalizeName(SPANISH_MONTHS[targetDate.getMonth()]);
  const anio = targetDate.getFullYear();

  for (const titulo of titulos) {
    const texto = normalizeName($(titulo).text());
    const m = texto.match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
    if (!m) continue;
    if (Number(m[1]) !== dia || m[2] !== mes || Number(m[3]) !== anio) continue;
    let nodo = $(titulo).parent();
    while (nodo.length && nodo.find('.bloqueClase').length === 0) nodo = nodo.parent();
    if (nodo.length) return $.html(nodo);
  }
  return html;
}

async function resolverListadoDelDia(page, targetDate) {
  const dayNumber = targetDate.getDate();
  const monthName = SPANISH_MONTHS[targetDate.getMonth()];
  const year = targetDate.getFullYear();
  const dayKey = toAimHarderDayKey(targetDate);

  return page.evaluate(
    ({ dayNumber, monthName, year, dayKey }) => {
      const normalize = (v) => String(v || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      const mesObjetivo = normalize(monthName);

      const parseFecha = (txt) => {
        const m = normalize(txt).match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
        return m ? { dia: Number(m[1]), mes: m[2], anio: Number(m[3]) } : null;
      };

      const esVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden';
      };

      // Contenedor del día = ancestro más cercano que agrupa las clases de ese
      // título. Si el día no tiene clases, se usa el ancestro razonable más
      // cercano (un día sin clases es un resultado válido, no un error).
      const contenedorDe = (titulo) => {
        let el = titulo.parentElement;
        let ultimo = titulo.parentElement;
        while (el && el !== document.body) {
          if (el.querySelector('.bloqueClase')) return el;
          ultimo = el;
          el = el.parentElement;
        }
        return titulo.closest('#clasesDiaSel') || ultimo || titulo.parentElement;
      };

      const titulos = Array.from(document.querySelectorAll('.titRvClass'));
      const info = titulos.map((t) => {
        const cont = contenedorDe(t);
        return {
          texto: (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          fecha: parseFecha(t.textContent || ''),
          visible: esVisible(t) || esVisible(cont),
          bloques: cont ? cont.querySelectorAll('.bloqueClase').length : 0,
          cont,
        };
      });

      // Vía secundaria: algún contenedor de clases identificado con la clave del
      // día (id/clase/data-*), que es como AimHarder marca las celdas semanales.
      // Se excluye la tira de días (#weekDays), que no contiene clases.
      const porClave = (() => {
        const clave = String(dayKey);
        const candidatos = Array.from(document.querySelectorAll(
          `[id*="${clave}"], [class*="${clave}"], [data-date*="${clave}"], [data-dia*="${clave}"]`
        ));
        return candidatos.find((el) => !el.closest('#weekDays') && el.querySelector('.bloqueClase')) || null;
      })();

      const coincide = info.find((i) => (
        i.fecha &&
        i.fecha.dia === dayNumber &&
        i.fecha.mes === mesObjetivo &&
        i.fecha.anio === year &&
        i.cont
      ));

      const elegido = coincide ? coincide.cont : porClave;

      return {
        encontrado: Boolean(elegido),
        via: coincide ? 'titulo' : (porClave ? 'clave-del-dia' : null),
        bloques: elegido ? elegido.querySelectorAll('.bloqueClase').length : 0,
        visible: coincide ? coincide.visible : Boolean(porClave && esVisible(porClave)),
        html: elegido ? elegido.outerHTML : null,
        totalBloques: document.querySelectorAll('.bloqueClase').length,
        totalTitulos: titulos.length,
        titulos: info.map(({ texto, visible, bloques }) => ({ texto, visible, bloques })),
      };
    },
    { dayNumber, monthName, year, dayKey }
  ).catch(() => null);
}

function getTermRenewalReportRange(referenceDateStr = null) {
  const referenceDate = referenceDateStr ? new Date(`${referenceDateStr}T12:00:00`) : new Date();
  if (Number.isNaN(referenceDate.getTime())) {
    throw new Error('Fecha de referencia inválida para calcular el informe de cancelaciones');
  }

  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();

  const lastDayOfMonth = new Date(year, month + 1, 0);
  const lastDayDow = lastDayOfMonth.getDay();
  const daysBackToMonday = lastDayDow === 0 ? 6 : lastDayDow - 1;
  const startDate = addDays(lastDayOfMonth, -daysBackToMonday);

  const firstDayNextMonth = new Date(year, month + 1, 1);
  const firstNextDow = firstDayNextMonth.getDay();
  const daysForwardToSunday = firstNextDow === 0 ? 0 : 7 - firstNextDow;
  const endDate = addDays(firstDayNextMonth, daysForwardToSunday);

  return {
    startDate,
    endDate,
    startIso: toDateString(startDate),
    endIso: toDateString(endDate),
    startInput: toDateInputValue(startDate),
    endInput: toDateInputValue(endDate),
  };
}

// Construye un rango de informe a partir de fechas explícitas "desde/hasta"
// (YYYY-MM-DD) elegidas por el usuario. Devuelve exactamente el mismo shape que
// getTermRenewalReportRange para que se usen tal cual en los inputs de AimHarder.
function buildExplicitReportRange(startStr, endStr) {
  const startDate = new Date(`${startStr}T12:00:00`);
  const endDate = new Date(`${endStr}T12:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error('Fechas desde/hasta inválidas para el informe');
  }
  return {
    startDate,
    endDate,
    startIso: toDateString(startDate),
    endIso: toDateString(endDate),
    startInput: toDateInputValue(startDate),
    endInput: toDateInputValue(endDate),
  };
}

function getMonthlyDateRange(monthStr = null) {
  const today = new Date();
  const parsed = monthStr ? String(monthStr).match(/^(\d{4})-(\d{2})$/) : null;

  const year = parsed ? Number(parsed[1]) : today.getFullYear();
  const month = parsed ? Number(parsed[2]) - 1 : today.getMonth();

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 0 || month > 11) {
    throw new Error('Formato de mes inválido. Usa YYYY-MM');
  }

  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 0);

  return {
    month: `${year}-${String(month + 1).padStart(2, '0')}`,
    startDate,
    endDate,
    startIso: toDateString(startDate),
    endIso: toDateString(endDate),
    startInput: toDateInputValue(startDate),
    endInput: toDateInputValue(endDate),
  };
}

function normalizeName(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function namesLikelyMatch(left = '', right = '') {
  const normalizedLeft = normalizeName(left);
  const normalizedRight = normalizeName(right);

  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const leftTokens = normalizedLeft.split(' ').filter(Boolean);
  const rightTokens = normalizedRight.split(' ').filter(Boolean);

  // Evitar coincidencias ambiguas por un solo nombre.
  if (leftTokens.length < 2 || rightTokens.length < 2) {
    return false;
  }

  const commonTokens = leftTokens.filter((token) => rightTokens.includes(token));

  return commonTokens.length >= Math.min(2, leftTokens.length, rightTokens.length);
}

function formatPercent(value, max) {
  if (!max) return 0;
  return Number(((value / max) * 100).toFixed(2));
}

function getPeriodByTime(time = '') {
  const hour = Number(String(time).split(':')[0] || 0);
  return hour < 15 ? 'morning' : 'afternoon';
}

function buildSavedClassKey(classTime = '', className = '') {
  return `${normalizeClassTime(classTime)}::${normalizeName(className)}`;
}

function toEnvKey(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function getCenterFallbackKey(center) {
  if (!center) return '';
  return toEnvKey(center.aimharderKey || center.name || '');
}

async function getCenterAimHarderConfig(centerId) {
  if (!centerId) {
    throw new Error('centerId es obligatorio para usar AimHarder');
  }

  const center = await Center.findById(centerId).lean();
  if (!center) {
    throw new Error('Centro no encontrado para configurar AimHarder');
  }

  const key = getCenterFallbackKey(center);
  const prefix = key ? `AIMHARDER_${key}_` : '';
  const read = (suffix, fallback = '') => process.env[`${prefix}${suffix}`] || fallback;
  const integration = await AimHarderIntegration.findOne({ center: center._id }).select(
    '+baseUrl +username +password +accessToken +refreshToken +lastTokenRefreshAt'
  );

  const envConfig = {
    baseUrl: read('URL', process.env.AIMHARDER_URL || ''),
    username: read('USERNAME', process.env.AIMHARDER_USERNAME || ''),
    password: read('PASSWORD', process.env.AIMHARDER_PASSWORD || ''),
    accessToken: read('API_ACCESS_TOKEN', process.env.AIMHARDER_API_ACCESS_TOKEN || ''),
    refreshToken: read('API_REFRESH_TOKEN', process.env.AIMHARDER_API_REFRESH_TOKEN || ''),
  };

  let persistedIntegration = integration;
  if (!persistedIntegration && (envConfig.baseUrl || envConfig.username || envConfig.accessToken || envConfig.refreshToken)) {
    persistedIntegration = await AimHarderIntegration.create({
      center: center._id,
      key,
      ...envConfig,
    });
  } else if (persistedIntegration) {
    const updates = {};
    if (!persistedIntegration.key && key) updates.key = key;
    if (!persistedIntegration.baseUrl && envConfig.baseUrl) updates.baseUrl = envConfig.baseUrl;
    if (!persistedIntegration.username && envConfig.username) updates.username = envConfig.username;
    if (!persistedIntegration.password && envConfig.password) updates.password = envConfig.password;
    if (!persistedIntegration.accessToken && envConfig.accessToken) updates.accessToken = envConfig.accessToken;
    if (!persistedIntegration.refreshToken && envConfig.refreshToken) updates.refreshToken = envConfig.refreshToken;
    if (Object.keys(updates).length > 0) {
      persistedIntegration = await AimHarderIntegration.findOneAndUpdate(
        { center: center._id },
        { $set: updates },
        { new: true }
      ).select('+baseUrl +username +password +accessToken +refreshToken +lastTokenRefreshAt');
    }
  }

  const config = {
    centerId: String(center._id),
    centerName: center.name,
    cacheKey: key || String(center._id),
    baseUrl: persistedIntegration?.baseUrl || envConfig.baseUrl,
    username: persistedIntegration?.username || envConfig.username,
    password: persistedIntegration?.password || envConfig.password,
    accessToken: persistedIntegration?.accessToken || envConfig.accessToken,
    refreshToken: persistedIntegration?.refreshToken || envConfig.refreshToken,
    envPrefix: prefix || 'AIMHARDER_',
    integrationId: persistedIntegration?._id ? String(persistedIntegration._id) : null,
  };

  if (!config.baseUrl) {
    throw new Error(`Falta ${config.envPrefix}URL para el centro ${center.name}`);
  }

  return config;
}

async function getSessionCache(config) {
  // 1. Cache en memoria (L1 — evita round-trip a DB)
  const memCache = sessionCacheByCenter.get(config.cacheKey);
  if (memCache && memCache.cookies && memCache.expiry && Date.now() < memCache.expiry) {
    return memCache;
  }
  // 2. MongoDB Atlas (L2 — persiste entre reinicios/deploys de Railway)
  const dbCache = await loadSessionFromDB(config);
  if (dbCache) {
    sessionCacheByCenter.set(config.cacheKey, dbCache);
    return dbCache;
  }
  return { cookies: null, expiry: null };
}

async function setSessionCache(config, value) {
  sessionCacheByCenter.set(config.cacheKey, value);
  await saveSessionToDB(config, value);
}

function getApiTokenCache(config) {
  const existing = apiTokenCacheByCenter.get(config.cacheKey);
  if (existing) return existing;

  const initial = {
    accessToken: config.accessToken || '',
    refreshToken: config.refreshToken || '',
  };
  apiTokenCacheByCenter.set(config.cacheKey, initial);
  return initial;
}

function aimharderApiRequest(pathname, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${API_BASE_URL}${pathname}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch {
            parsed = body;
          }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

async function refreshAimHarderApiTokens(config) {
  const apiTokenCache = getApiTokenCache(config);
  if (!apiTokenCache.refreshToken) {
    throw new Error(`Falta refresh token de AimHarder para ${config.centerName}. Configúralo en la integración del centro o en el .env para la siembra inicial.`);
  }

  const response = await aimharderApiRequest('/auth/tokens/refresh', apiTokenCache.refreshToken);
  if (response.statusCode < 200 || response.statusCode >= 300 || !response.body) {
    if (response.statusCode === 410) {
      throw new Error(`El refresh token de AimHarder API para ${config.centerName} ha caducado o ya no es válido. Genera una nueva pareja de tokens en Configuración > API y actualízala en la integración del centro.`);
    }
    throw new Error(`No se pudieron refrescar los tokens de AimHarder API (${response.statusCode})`);
  }

  const { accessToken: nextAccessToken, refreshToken: nextRefreshToken } = extractAimHarderTokenPayload(response.body);
  if (!nextAccessToken) {
    const detail =
      typeof response.body === 'string'
        ? response.body
        : JSON.stringify(response.body);
    throw new Error(`La API de AimHarder no devolvió un access token nuevo. Respuesta: ${detail}`);
  }

  apiTokenCache.accessToken = nextAccessToken;
  if (nextRefreshToken) {
    apiTokenCache.refreshToken = nextRefreshToken;
  }

  if (config.integrationId) {
    await AimHarderIntegration.findByIdAndUpdate(config.integrationId, {
      $set: {
        accessToken: apiTokenCache.accessToken,
        refreshToken: apiTokenCache.refreshToken,
        lastTokenRefreshAt: new Date(),
      },
    });
  }

  console.log('[AimHarder API] Tokens refrescados correctamente');
  return apiTokenCache.accessToken;
}

async function getAimHarderApiAccessToken(config) {
  const apiTokenCache = getApiTokenCache(config);
  if (!apiTokenCache.accessToken) {
    throw new Error(`Falta access token de AimHarder para ${config.centerName}. Configúralo en la integración del centro o en el .env para la siembra inicial.`);
  }
  return apiTokenCache.accessToken;
}

function unwrapAimHarderListResponse(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.clients)) return body.clients;
  return [];
}

function extractAimHarderTokenPayload(body) {
  if (!body || typeof body !== 'object') return { accessToken: '', refreshToken: '' };

  const candidates = [body, body.data, body.tokens, body.result].filter(
    (value) => value && typeof value === 'object'
  );

  for (const candidate of candidates) {
    const accessToken =
      candidate['access-token'] ||
      candidate.access_token ||
      candidate.accessToken ||
      candidate.token ||
      '';
    const refreshToken =
      candidate['refresh-token'] ||
      candidate.refresh_token ||
      candidate.refreshToken ||
      '';

    if (accessToken || refreshToken) {
      return { accessToken, refreshToken };
    }
  }

  return { accessToken: '', refreshToken: '' };
}

// ─────────────────────────────────────────────────────
// Debug helpers
// ─────────────────────────────────────────────────────

async function saveDebugSnapshot(page, label) {
  if (!PLAYWRIGHT_DEBUG) return;
  try {
    const ts = Date.now();
    const screenshotPath = path.join(DEBUG_DIR, `${ts}_${label}.png`);
    const htmlPath = path.join(DEBUG_DIR, `${ts}_${label}.html`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(htmlPath, html, 'utf8');
    console.log(`[AimHarder DEBUG] Snapshot guardado: debug/${ts}_${label}.png | .html`);
  } catch (e) {
    console.warn('[AimHarder DEBUG] No se pudo guardar snapshot:', e.message);
  }
}

// ─────────────────────────────────────────────────────
// Cookie banner dismissal — se puede llamar en cualquier momento
// ─────────────────────────────────────────────────────

async function dismissCookies(page) {
  // Estrategia 1: Playwright locator con regex case-insensitive
  // (funciona aunque el DOM tenga "Aceptar todas" y CSS lo muestre en mayúsculas)
  for (const pattern of [/^aceptar todas$/i, /^denegar todas$/i]) {
    try {
      const loc = page.getByText(pattern);
      if (await loc.count() > 0) {
        await loc.first().click({ force: true, timeout: 3000 });
        console.log(`[AimHarder] Cookies dismissadas con locator: ${pattern}`);
        await page.waitForTimeout(600).catch(() => {});
        return true;
      }
    } catch {}
  }

  // Estrategia 2: evaluate buscando por textContent en toda la jerarquía
  const result = await page.evaluate(() => {
    function findAndClick(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        // Solo nodos con texto directo (no containers con mucho texto)
        const ownText = Array.from(node.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent.trim())
          .join('');
        if (/^(aceptar|denegar) todas$/i.test(ownText)) {
          node.click();
          return ownText;
        }
      }
      return null;
    }
    return findAndClick(document.body);
  });

  if (result) {
    console.log(`[AimHarder] Cookies dismissadas via evaluate: "${result}"`);
    await page.waitForTimeout(600).catch(() => {});
    return true;
  }

  console.log('[AimHarder] Banner de cookies no encontrado');
  return false;
}

// ─────────────────────────────────────────────────────
// Cierre de banners promocionales / avisos de AimHarder
// (p. ej. "¡Hemos rediseñado el menú!") que se superponen y tapan botones
// como "Generar informe". Sin cerrarlos, el clic no llega al botón real.
// ─────────────────────────────────────────────────────

async function dismissAimHarderPromos(page) {
  try {
    const removed = await page.evaluate(() => {
      const stripAccents = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
      const norm = (v) => stripAccents(String(v || '').replace(/\s+/g, ' ').trim().toLowerCase());
      // Frases (sin acentos) que identifican estos avisos flotantes.
      const promoNeedles = [
        'hemos rediseñado',
        'rediseñado el menu',
        'probar ahora',
        'nuevas opciones',
      ].map(stripAccents).map((s) => s.toLowerCase());

      const matchesPromo = (el) => {
        const text = norm(el.textContent);
        if (text.length > 400) return false; // evitar contenedores enormes
        return promoNeedles.some((needle) => text.includes(needle));
      };

      let actions = 0;
      const candidates = Array.from(document.querySelectorAll('div, section, aside'))
        .filter((el) => matchesPromo(el));

      for (const el of candidates) {
        // Subir hasta el contenedor flotante (fixed/absolute) del aviso.
        let container = el;
        for (let i = 0; i < 6 && container.parentElement; i += 1) {
          const pos = window.getComputedStyle(container).position;
          if (pos === 'fixed' || pos === 'absolute') break;
          container = container.parentElement;
        }

        // Intentar pulsar su botón de cerrar (× / close) antes de eliminar.
        const closeBtn = Array.from(container.querySelectorAll('button, a, span, i, [class*="close"], [aria-label]'))
          .find((btn) => {
            const t = norm(btn.textContent);
            const aria = norm(btn.getAttribute && btn.getAttribute('aria-label'));
            const cls = norm(btn.className && btn.className.baseVal !== undefined ? btn.className.baseVal : btn.className);
            return t === '×' || t === 'x' || t === '✕' || aria.includes('cerrar') || aria.includes('close') || cls.includes('close');
          });
        if (closeBtn) {
          try { closeBtn.click(); actions += 1; } catch { /* noop */ }
        }

        // Como refuerzo, ocultar/eliminar el contenedor para que no tape nada.
        try {
          container.style.setProperty('display', 'none', 'important');
          actions += 1;
        } catch { /* noop */ }
      }

      return actions;
    });

    if (removed > 0) {
      console.log(`[AimHarder] Banners promocionales cerrados/ocultados: ${removed}`);
      await page.waitForTimeout(300).catch(() => {});
    }
    return removed > 0;
  } catch (e) {
    console.warn('[AimHarder] No se pudieron cerrar los banners promocionales:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────

async function login(page, config) {
  const username = config.username || '';
  const password = config.password || '';

  // PASO 1: Abrir aimharder.com
  console.log('[AimHarder] 1. Abriendo aimharder.com...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await saveDebugSnapshot(page, '01_home');

  // PASO 2: Aceptar cookies en la página de inicio
  console.log('[AimHarder] 2. Aceptando cookies en página de inicio...');
  await dismissCookies(page);

  // PASO 3: Clicar "Iniciar sesión" en el nav
  console.log('[AimHarder] 3. Clicando Iniciar sesión...');
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const clicked = await page.evaluate(() => {
    // Buscar cualquier enlace/botón que diga "Iniciar sesión" en el nav
    const candidates = Array.from(document.querySelectorAll('a, button'));
    for (const el of candidates) {
      const text = el.textContent?.trim() || '';
      if (/^iniciar\s*sesi[oó]n$/i.test(text) || /^login$/i.test(text)) {
        el.click();
        return text;
      }
    }
    return null;
  });
  console.log('[AimHarder] Enlace clicado:', clicked || 'no encontrado, navegando directo a login');

  // Si no encontró el enlace, ir directamente al servicio de auth
  if (!clicked) {
    await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (!page.url().includes('login.aimharder.com')) {
      console.log('[AimHarder] El click no abrió el formulario real, navegando directo a login...');
      await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
  }

  await saveDebugSnapshot(page, '02_login_form');
  console.log('[AimHarder] URL formulario:', page.url());

  // PASO 4: Aceptar cookies en la página del formulario de login
  console.log('[AimHarder] 4. Aceptando cookies en página de login...');
  await dismissCookies(page);

  // PASO 5: Rellenar correo
  console.log('[AimHarder] 5. Rellenando correo...');
  await page.locator('input[type="text"], input[type="email"], input[name="login"], input[placeholder*="Correo" i]')
    .first()
    .fill(username);

  // PASO 6: Rellenar contraseña
  console.log('[AimHarder] 6. Rellenando contraseña...');
  const passLocator = page.locator('input[type="password"]').first();
  await passLocator.fill(password);

  await saveDebugSnapshot(page, '03_form_filled');

  // PASO 7: Clicar "Iniciar sesión" (botón submit)
  console.log('[AimHarder] 7. Clicando Iniciar sesión (submit)...');
  const submitClicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    for (const el of candidates) {
      const text = el.textContent?.trim() || el.value || '';
      if (/iniciar|login|entrar|acceder|submit/i.test(text) || el.type === 'submit') {
        el.click();
        return text || 'submit';
      }
    }
    return null;
  });
  if (!submitClicked) {
    console.log('[AimHarder] Botón submit no encontrado, usando Enter');
    await passLocator.press('Enter');
  } else {
    console.log('[AimHarder] Submit clicado:', submitClicked);
  }

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500).catch(() => {});
  if (!isAuthenticatedAimHarderUrl(page.url())) {
    console.log('[AimHarder] Consolidando sesión en el panel del box...');
    await page.goto(`${config.baseUrl}/control`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  }
  await saveDebugSnapshot(page, '04_after_login');
  console.log('[AimHarder] URL post-login:', page.url());

  if (!isAuthenticatedAimHarderUrl(page.url())) {
    // Eliminar sesión para no reutilizar cookies corruptas en el siguiente intento
    sessionCacheByCenter.delete(config.cacheKey);
    await deleteSessionFromDB(config);
    throw new Error(`Login de AimHarder incompleto. URL final: ${page.url()}`);
  }
}

function isAuthenticatedAimHarderUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith('.aimharder.com') && parsed.hostname !== 'aimharder.com' && parsed.hostname !== 'login.aimharder.com';
  } catch {
    return false;
  }
}

async function ensureAuthenticatedSession(page, config) {
  const probeUrl = `${config.baseUrl}/control`;
  console.log('[AimHarder] Comprobando si la sesión ya está iniciada...');
  await page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200).catch(() => {});
  await dismissCookies(page);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const currentUrl = page.url();
  console.log('[AimHarder] URL tras comprobar sesión:', currentUrl);

  if (isAuthenticatedAimHarderUrl(currentUrl)) {
    console.log('[AimHarder] Sesión activa detectada, se reutilizan cookies');
    await saveDebugSnapshot(page, '00_session_reused');
    return;
  }

  console.log('[AimHarder] No hay sesión válida, iniciando login completo...');
  await login(page, config);
}

// ─────────────────────────────────────────────────────
// Navegación a Reservas y al día correcto
// ─────────────────────────────────────────────────────

async function openReservationsDay(page, targetDate, config, snap = async () => {}) {
  // Se escucha desde ANTES de abrir la página: así se ve qué petición sirve las
  // reservas del día, que es la que hay que reproducir para otra fecha.
  const erroresJs = [];
  const peticiones = [];
  const onPageError = (err) => erroresJs.push(String(err && err.message ? err.message : err).slice(0, 200));
  const onConsole = (msg) => { if (msg.type() === 'error') erroresJs.push(`console: ${msg.text()}`.slice(0, 200)); };
  const onRequest = (req) => {
    const url = req.url();
    if (/\.(png|jpe?g|gif|css|woff2?|svg|ico)(\?|$)/i.test(url)) return;
    if (/google|gstatic|stripe|facebook|doubleclick|hotjar/i.test(url)) return;
    peticiones.push(`${req.method()} ${url.slice(0, 170)}`);
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('request', onRequest);
  const quitarEscuchas = () => {
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
    page.off('request', onRequest);
  };

  const scheduleUrl = `${config.baseUrl}/schedule?adm`;
  console.log('[AimHarder] Navegando a schedule:', scheduleUrl);
  await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200).catch(() => {});
  await dismissCookies(page);
  // AimHarder muestra banners flotantes ("hemos rediseñado el menú") que pueden
  // tapar el calendario del horario. Se cierran igual que en el resto de scrapers.
  await dismissAimHarderPromos(page);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await saveDebugSnapshot(page, '04_schedule_today');
  await snap('1. Reservas recién abierto (debe mostrar HOY)');

  try {
    await page.waitForSelector('#weekDays, #clasesDiaSel', { timeout: 20000 });
  } catch {
    // Sin esto el fallo llega al usuario como un 500 genérico: damos contexto real.
    await saveDebugSnapshot(page, '04b_sin_calendario');
    const diag = await page.evaluate(() => ({
      title: document.title,
      bloques: document.querySelectorAll('.bloqueClase').length,
      texto: (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    })).catch(() => null);
    throw new Error(
      `No se encontró el calendario del horario (#weekDays/#clasesDiaSel) en ${page.url()}. ` +
      `Diagnóstico: ${JSON.stringify(diag)}`
    );
  }

  const dayKey = toAimHarderDayKey(targetDate);
  const daySelector = `#weekDays .wds${dayKey}`;
  const targetDay = targetDate.getDate();

  console.log('[AimHarder] Seleccionando día objetivo:', dayKey);

  // Espera corta de "asentamiento" tras cada intento de navegación, más una
  // espera de red por si el cambio de día dispara una petición AJAX.
  const settle = async () => {
    await page.waitForTimeout(1500).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  };

  // Bitácora de TODO lo que se intenta, en texto. Sin esto no hay forma de
  // saber qué estrategia se ejecutó realmente: el diagnóstico anterior decía
  // "DÍA CORRECTO" en el paso 4 y las estrategias 1b-4 ni siquiera llegaban a
  // probarse, porque la confirmación daba un falso positivo.
  const bitacora = [];
  const apunta = (texto) => {
    bitacora.push(texto);
    console.log('[AimHarder]', texto);
  };

  // Única prueba admitida de que estamos en el día pedido: existe en el DOM el
  // listado de ese día (título con la fecha exacta, o contenedor con la clave
  // del día) y tiene clases. NO vale que la celda quede marcada: AimHarder la
  // marca al pulsarla aunque el listado no cambie, y eso es exactamente lo que
  // hacía pasar por buena una navegación que nunca ocurrió.
  const confirmarDia = async (timeoutMs = 6000) => {
    const limite = Date.now() + timeoutMs;
    for (;;) {
      const ambito = await resolverListadoDelDia(page, targetDate);
      if (ambito && ambito.encontrado && (ambito.bloques > 0 || ambito.totalBloques === 0)) return true;
      if (Date.now() >= limite) return false;
      await page.waitForTimeout(500).catch(() => {});
    }
  };

  await snap(`2. Antes de pulsar el día ${targetDay} (tira semanal visible)`);

  // ── Vía principal: pedir el día a la misma API que usa AimHarder ──
  // Es lo que hace `weekSelDay`: GET /api/coachBookings?day=YYYYMMDD. Ningún
  // clic recarga la página, por eso todas las estrategias de clic fallaban.
  const viaApi = await pedirDiaAApiCoachBookings(page, targetDate);
  if (viaApi.ok && viaApi.json) {
    const n = viaApi.json.bookings.length;
    apunta(`E0 /api/coachBookings?day=${dayKey} -> DÍA CARGADO (JSON, ${n} clases, dayYYYYMMDD=${viaApi.json.dayYYYYMMDD})`);
    await snap(`3. Día ${targetDay} pedido a /api/coachBookings`, `INTENTOS:\n- ${bitacora.join('\n- ')}`);
    quitarEscuchas();
    return { bookings: viaApi.json };
  }
  if (viaApi.ok) {
    const htmlDelDia = acotarHtmlAlDia(viaApi.html, targetDate);
    apunta(`E0 /api/coachBookings?day=${dayKey} -> DÍA CARGADO (${htmlDelDia.length} caracteres)`);
    await snap(`3. Día ${targetDay} pedido a /api/coachBookings`, `INTENTOS:\n- ${bitacora.join('\n- ')}`);
    quitarEscuchas();
    return { scopeHtml: htmlDelDia };
  }
  apunta(`E0 /api/coachBookings?day=${dayKey} -> FALLA: ${viaApi.detalle}`);

  let found = false;

  // Estrategia 1: pulsar la celda del día como lo haría una persona.
  // IMPORTANTE: primero SIN `force`. Con `force` el navegador dispara el clic
  // aunque haya algo encima (un banner), y entonces el clic se lo queda ese algo
  // sin que nos enteremos. El clic normal falla con un mensaje que dice QUÉ lo
  // está interceptando, y eso se guarda para el diagnóstico.
  let motivoClicBloqueado = null;
  let resultadoOnclick = null;
  let resultadoWeekSelDay = null;
  const directButton = page.locator(daySelector).first();
  if (await directButton.count()) {
    await directButton.scrollIntoViewIfNeeded().catch(() => {});
    console.log('[AimHarder] Estrategia 1: clic normal en', daySelector);
    try {
      await directButton.click({ timeout: 5000 });
    } catch (e) {
      motivoClicBloqueado = String(e.message).split('\n').slice(0, 3).join(' | ').slice(0, 300);
      console.log('[AimHarder] Clic normal bloqueado ->', motivoClicBloqueado);
      // Se reintenta cerrando banners y, ya como último recurso, forzando.
      await dismissAimHarderPromos(page);
      await directButton.click({ timeout: 5000 }).catch(async () => {
        await directButton.click({ force: true }).catch(() => {});
      });
    }
    await settle();
    await snap(`3. Tras pulsar el día ${targetDay}${motivoClicBloqueado ? ' (el clic normal falló)' : ''}`);
    found = await confirmarDia();
    apunta(`E1 clic en la celda -> ${found ? 'DÍA CARGADO' : 'no cambia el día'}${motivoClicBloqueado ? ` (clic normal bloqueado: ${motivoClicBloqueado})` : ''}`);
    await snap(`4. Resultado del clic: ${found ? 'DÍA CORRECTO' : 'sigue en otro día'}`);
  }

  // Estrategia 1b: ejecutar la acción que la propia celda tiene asignada. Es lo
  // que haría un clic real; el clic sintético puede marcar la celda sin disparar
  // la recarga del listado.
  if (!found) {
    const accion = await page.evaluate((selector) => {
      const cell = document.querySelector(selector);
      if (!cell) return null;
      const onclick = cell.getAttribute('onclick');
      if (onclick) {
        try {
          new Function(onclick).call(cell);
          return `ejecutado: ${onclick.slice(0, 80)}`;
        } catch (e) {
          // Tragarse este error era el fallo: si weekSelDay revienta, aquí está.
          return `EXCEPCION al ejecutar onclick: ${e && e.message ? e.message : e}`;
        }
      }
      const link = cell.tagName === 'A' ? cell : cell.querySelector('a');
      if (link) { link.click(); return 'click en <a> interno'; }
      return null;
    }, daySelector).catch(() => null);
    resultadoOnclick = accion;
    if (accion) {
      await settle();
      found = await confirmarDia();
      apunta(`E1b onclick de la celda (${accion}) -> ${found ? 'DÍA CARGADO' : 'no cambia el día'}`);
    } else {
      apunta('E1b la celda no tiene onclick ni enlace interno');
    }
  }

  // Estrategia 1c: cargar el día directamente por URL. Está comprobado que
  // weekSelDay() no dispara NINGUNA petición en el navegador automático (solo se
  // ven llamadas de notificaciones y de Stripe), así que su JS no sirve aquí.
  // Se prueban los parámetros habituales y se valida el resultado: si ninguno
  // carga el día pedido, se sigue con el resto de estrategias.
  if (!found) {
    for (const parametro of ['date', 'dia', 'fecha', 'day']) {
      if (found) break;
      const url = `${config.baseUrl}/schedule?adm&${parametro}=${dayKey}`;
      console.log('[AimHarder] Estrategia 1c: probando URL', url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
      await dismissCookies(page);
      await dismissAimHarderPromos(page);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      found = await confirmarDia(4000);
      apunta(`E1c URL ?${parametro}=${dayKey} -> ${found ? 'DÍA CARGADO' : 'no cambia el día'}`);
    }
  }

  // Estrategia 2: invocar directamente la función JS de AimHarder.
  if (!found) {
    console.log('[AimHarder] Estrategia 2: window.weekSelDay(', dayKey, ')');
    resultadoWeekSelDay = await page.evaluate((value) => {
      if (typeof window.weekSelDay !== 'function') return 'weekSelDay NO es una función';
      try {
        window.weekSelDay(value);
        return 'weekSelDay ejecutada sin excepción';
      } catch (e) {
        return `EXCEPCION en weekSelDay: ${e && e.message ? e.message : e}`;
      }
    }, dayKey).catch((e) => `no se pudo evaluar: ${e.message}`);
    await settle();
    found = await confirmarDia();
    apunta(`E2 weekSelDay(${dayKey}) [${resultadoWeekSelDay}] -> ${found ? 'DÍA CARGADO' : 'no cambia el día'}`);
  }

  // Estrategia 3: usar el selector de fecha "Ir a día", útil para fechas de
  // semanas distintas a la mostrada actualmente.
  if (!found) {
    console.log('[AimHarder] Estrategia 3: input "Ir a día"');
    const dateInputValue = [
      targetDate.getFullYear(),
      String(targetDate.getMonth() + 1).padStart(2, '0'),
      String(targetDate.getDate()).padStart(2, '0'),
    ].join('-');
    await page.evaluate((value) => {
      const normalize = (v) => String(v || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase();

      const inputs = Array.from(document.querySelectorAll('input[type="date"]'));
      if (inputs.length === 0) return;

      let input = inputs.find((el) => {
        const container = el.closest('div, label, form, td, section') || el.parentElement;
        return container && normalize(container.textContent).includes('ir a dia');
      });
      if (!input) input = inputs[0];

      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, dateInputValue);
    await settle();
    found = await confirmarDia();
    apunta(`E3 input "Ir a día" = ${dateInputValue} -> ${found ? 'DÍA CARGADO' : 'no cambia el día'}`);
  }

  // Estrategia 4: navegar semana a semana con las flechas del calendario hasta
  // que la celda del día objetivo aparezca en la tira semanal.
  if (!found) {
    console.log('[AimHarder] Estrategia 4: flechas de semana');
    for (let i = 0; i < 8 && !found; i += 1) {
      const weekInfo = await page.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('#weekDays [class*="wds"]'));
        const dates = cells
          .map((cell) => {
            const match = Array.from(cell.classList).find((cls) => /^wds\d{8}$/.test(cls));
            if (!match) return null;
            const raw = match.replace('wds', '');
            return {
              year: Number(raw.slice(0, 4)),
              month: Number(raw.slice(4, 6)),
              day: Number(raw.slice(6, 8)),
            };
          })
          .filter(Boolean);
        if (dates.length === 0) return null;
        const toTime = (d) => new Date(d.year, d.month - 1, d.day).getTime();
        const first = dates.reduce((a, b) => (toTime(a) < toTime(b) ? a : b));
        const last = dates.reduce((a, b) => (toTime(a) > toTime(b) ? a : b));
        return {
          firstTime: toTime(first),
          lastTime: toTime(last),
        };
      });

      if (!weekInfo) break;

      const targetTime = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()).getTime();
      const direction = targetTime < weekInfo.firstTime ? 'prev' : (targetTime > weekInfo.lastTime ? 'next' : null);
      if (!direction) break;

      const clicked = await page.evaluate((dir) => {
        const weekDaysEl = document.querySelector('#weekDays');
        if (!weekDaysEl) return false;

        // Buscamos el contenedor del navegador semanal (el ancestro que agrupa
        // la tira de días junto con las flechas de anterior/siguiente semana).
        let container = weekDaysEl.parentElement;
        for (let hops = 0; hops < 4 && container; hops += 1) {
          const candidates = Array.from(container.querySelectorAll('a, button, div, span, img, i')).filter((el) => {
            if (el.closest('#weekDays')) return false;
            const attrs = `${el.getAttribute('onclick') || ''} ${el.id || ''} ${el.className || ''}`;
            return /week|sem/i.test(attrs);
          });
          if (candidates.length > 0) {
            const weekDaysRect = weekDaysEl.getBoundingClientRect();
            const prevCandidates = candidates.filter((el) => el.getBoundingClientRect().left <= weekDaysRect.left);
            const nextCandidates = candidates.filter((el) => el.getBoundingClientRect().left > weekDaysRect.left);
            const target = dir === 'prev'
              ? (prevCandidates[prevCandidates.length - 1] || candidates[0])
              : (nextCandidates[0] || candidates[candidates.length - 1]);
            if (target) {
              target.click();
              return true;
            }
          }
          container = container.parentElement;
        }
        return false;
      }, direction);

      if (!clicked) break;

      await settle();

      const dayNowVisible = await page.locator(daySelector).count();
      if (dayNowVisible) {
        console.log('[AimHarder] Estrategia 4: celda del día encontrada, clicando', daySelector);
        await page.locator(daySelector).first().click({ force: true });
        await settle();
        found = await confirmarDia();
        apunta(`E4 flechas de semana + clic en la celda -> ${found ? 'DÍA CARGADO' : 'no cambia el día'}`);
      }
    }
  }

  if (!found) {
    await saveDebugSnapshot(page, '04c_dia_no_encontrado');
    const diag = await page.evaluate(() => {
      const weekLabel = Array.from(document.querySelectorAll('*'))
        .find((el) => el.children.length === 0 && /\d{1,2}\s+\w+\s*-\s*\d{1,2}\s+\w+/.test(el.textContent || ''));
      return {
        url: window.location.href,
        titulo: document.querySelector('#clasesDiaSel .titRvClass')?.textContent?.trim() || null,
        semana: weekLabel ? weekLabel.textContent.trim() : null,
        diasEnTira: Array.from(document.querySelectorAll('#weekDays [class*="wds"]'))
          .flatMap((cell) => Array.from(cell.classList).filter((cls) => /^wds\d{8}$/.test(cls))),
        bloques: document.querySelectorAll('.bloqueClase').length,
        funcionesWindow: Object.keys(window).filter((k) => /week|dia|day|sel|cal/i.test(k) && typeof window[k] === 'function'),
      };
    }).catch(() => null);

    const targetDateStr = [
      targetDate.getFullYear(),
      String(targetDate.getMonth() + 1).padStart(2, '0'),
      String(targetDate.getDate()).padStart(2, '0'),
    ].join('-');

    quitarEscuchas();
    throw new Error(
      `No se pudo abrir el día ${targetDateStr} en el horario de AimHarder.\n` +
      `INTENTOS:\n- ${bitacora.join('\n- ')}\n` +
      `PETICIONES XHR VISTAS (últimas 12):\n- ${peticiones.slice(-12).join('\n- ')}\n` +
      `ERRORES JS: ${JSON.stringify(erroresJs.slice(-4))}\n` +
      `DIAGNÓSTICO: ${JSON.stringify(diag)}`
    );
  }

  await dismissCookies(page);
  await dismissAimHarderPromos(page);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // Confirmación final ANTES de leer las clases: el listado debe pertenecer ya al
  // día objetivo. Sin esto se puede parsear el día anterior mientras AimHarder
  // repinta por AJAX (el usuario veía los avisos de hoy al pedir los de ayer).
  // Confirmación final antes de leer nada: o el título ya es el del día pedido,
  // o el listado ha cambiado con la celda de ese día marcada. Si no, se aborta:
  // anotar avisos sobre el día equivocado es peor que fallar.
  // NO se vuelve a exigir el título aquí. Comprobado en producción: AimHarder
  // NO repinta "#clasesDiaSel .titRvClass" al cambiar de día (seguía diciendo
  // "23 de Septiembre" con el día 22 ya cargado). Exigirlo tiraba por la borda
  // una navegación que SÍ había funcionado ("Resultado del clic: DÍA CORRECTO").
  // La prueba válida ya se hizo durante la navegación: el listado cambió de
  // verdad y la celda del día quedó marcada. Aquí solo se verifica que esa celda
  // siga marcada, que es condición necesaria para no leer otro día.
  // Comprobación final ANTES de leer nada: se localiza el contenedor cuyo
  // título es EXACTAMENTE el día pedido. Si no existe, se aborta: anotar avisos
  // del día equivocado es peor que fallar. Y si existe, se devuelve su HTML para
  // que el parseo lea SOLO ese día (no `.bloqueClase` de todo el documento, que
  // era lo que colaba las clases de hoy al pedir las de ayer).
  const ambitoFinal = await resolverListadoDelDia(page, targetDate);

  if (!ambitoFinal || !ambitoFinal.encontrado) {
    await saveDebugSnapshot(page, '04d_dia_no_confirmado');
    quitarEscuchas();
    const comoCambiaDeDia = await page.evaluate((sel) => {
      const celda = document.querySelector(sel);
      const fuente = (nombre) => {
        try {
          return typeof window[nombre] === 'function' ? String(window[nombre]).replace(/\s+/g, ' ').slice(0, 700) : null;
        } catch { return null; }
      };
      const candidatas = Object.keys(window)
        .filter((k) => /week|dia|day|sem|sched|rv|cal/i.test(k) && typeof window[k] === 'function')
        .slice(0, 25);
      return {
        onclickCelda: celda ? celda.getAttribute('onclick') : 'NO EXISTE LA CELDA',
        htmlCelda: celda ? celda.outerHTML.replace(/\s+/g, ' ').slice(0, 300) : null,
        weekSelDay: fuente('weekSelDay'),
        funcionesCandidatas: candidatas,
      };
    }, daySelector).catch((e) => ({ error: e.message }));
    const detalle = ambitoFinal
      ? `Títulos encontrados en la página (${ambitoFinal.totalTitulos}): ` +
        JSON.stringify(ambitoFinal.titulos) +
        `. Bloques de clase en todo el documento: ${ambitoFinal.totalBloques}.`
      : 'No se pudo inspeccionar el DOM del horario.';
    throw new Error(
      `El horario no muestra el día ${toDateString(targetDate)}. ${detalle}\n` +
      `INTENTOS:\n- ${bitacora.join('\n- ')}\n` +
      `CÓMO CAMBIA DE DÍA AIMHARDER: ${JSON.stringify(comoCambiaDeDia)}\n` +
      `PETICIONES XHR VISTAS (últimas 12):\n- ${peticiones.slice(-12).join('\n- ')}\n` +
      'Se aborta para no anotar avisos del día equivocado.'
    );
  }

  // Resumen técnico en TEXTO, fácil de copiar y pegar.
  const resumen = [
    `DIA PEDIDO: ${toDateString(targetDate)} (clave ${dayKey})`,
    `LISTADO DEL DIA LOCALIZADO: si (via=${ambitoFinal.via}, visible=${ambitoFinal.visible})`,
    `BLOQUES DE ESE DIA: ${ambitoFinal.bloques} (en todo el documento: ${ambitoFinal.totalBloques})`,
    `TITULOS EN LA PAGINA (${ambitoFinal.totalTitulos}): ${JSON.stringify(ambitoFinal.titulos)}`,
    `INTENTOS: ${bitacora.join(' | ')}`,
    `ERRORES JS: ${JSON.stringify(erroresJs.slice(-4))}`,
  ].join('\n');
  console.log('[AimHarder] RESUMEN\n' + resumen);
  await snap(`RESUMEN TÉCNICO (día ${targetDay})`, resumen);

  await page.waitForFunction(
    () => {
      const blocks = Array.from(document.querySelectorAll('.bloqueClase'));
      if (blocks.length === 0) return false;

      const hasOccupiedClass = blocks.some((block) => {
        const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
        const match = text.match(/Plazas ocupadas\s*(\d+)\s*\/\s*(\d+)/i);
        return Boolean(match && Number(match[1]) > 0);
      });

      if (!hasOccupiedClass) return true;

      return document.querySelectorAll('.bloqueClase .rvApuntados .atletaClase').length > 0;
    },
    { timeout: 7000 }
  ).catch(() => {});
  await page.waitForTimeout(800).catch(() => {});
  quitarEscuchas();
  await snap(`5. Estado final antes de leer las clases (día ${targetDay})`);
  await saveDebugSnapshot(page, `05_schedule_day${targetDay}`);

  // Se vuelve a resolver tras las esperas: el DOM puede haberse rellenado.
  const ambitoListo = await resolverListadoDelDia(page, targetDate);
  return {
    scopeHtml: (ambitoListo && ambitoListo.encontrado ? ambitoListo.html : ambitoFinal.html) || null,
  };
}

// ─────────────────────────────────────────────────────
// Parseo de respuestas AJAX interceptadas
// ─────────────────────────────────────────────────────

function parseBookingsJson(data, targetDate) {
  // Guarda el JSON en debug para inspeccionarlo manualmente
  try {
    const jsonPath = path.join(DEBUG_DIR, `${Date.now()}_ajax_response.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
    console.log('[AimHarder DEBUG] JSON AJAX guardado en debug/');
  } catch {}

  const absences = [];
  const dateStr = toDateString(targetDate);

  const processBookingList = (bookings, classTime, className) => {
    if (!Array.isArray(bookings)) return;
    for (const b of bookings) {
      // AimHarder devuelve "falta" o "attendance" = 0/false/"0"/"false" para ausencias
      const attendanceVal =
        b.falta ??
        b.attendance ??
        b.attended ??
        b.assist ??
        b.present ??
        b.noShow ??
        null;

      const isAbsent =
        attendanceVal === 1 || // "falta: 1" = marcado como falta
        attendanceVal === true ||
        attendanceVal === '1' ||
        attendanceVal === 'true' ||
        attendanceVal === 0 || // "attendance: 0" = no asistió
        attendanceVal === false ||
        attendanceVal === '0' ||
        attendanceVal === 'false' ||
        (typeof attendanceVal === 'string' && attendanceVal.toLowerCase() === 'falta');

      if (!isAbsent) continue;

      const name =
        b.name ||
        [b.firstName, b.lastName].filter(Boolean).join(' ') ||
        [b.nombre, b.apellidos].filter(Boolean).join(' ') ||
        b.userName ||
        b.user ||
        '';

      if (name) {
        absences.push({ memberName: name.trim(), classTime, className, date: dateStr });
      }
    }
  };

  // Distintos formatos posibles de respuesta
  if (Array.isArray(data)) {
    // Array de clases
    for (const cls of data) {
      const classTime = cls.hour || cls.time || cls.startTime || cls.ini || '';
      const className = cls.name || cls.className || cls.activityName || cls.activity || '';
      const bookings = cls.bookings || cls.members || cls.attendees || cls.reservations || [];
      processBookingList(bookings, classTime, className);
    }
  } else if (data && typeof data === 'object') {
    // Objeto con array de clases
    const classes =
      data.classes ||
      data.schedule ||
      data.bookings ||
      data.list ||
      data.data ||
      [];
    if (Array.isArray(classes)) {
      for (const cls of classes) {
        const classTime = cls.hour || cls.time || cls.startTime || cls.ini || '';
        const className = cls.name || cls.className || cls.activityName || '';
        const bookings = cls.bookings || cls.members || cls.attendees || cls.reservations || [];
        processBookingList(bookings, classTime, className);
      }
    }
  }

  return absences;
}

// ─────────────────────────────────────────────────────
// Parseo del HTML con cheerio (fallback)
// ─────────────────────────────────────────────────────

async function parseHtmlForAbsences(page, targetDate) {
  const cheerio = require('cheerio');
  const html = await page.content();
  const $ = cheerio.load(html);
  const dateStr = toDateString(targetDate);
  const absences = [];

  // Loguear todas las clases únicas presentes en el HTML
  // (ayuda a identificar los selectores correctos)
  const allClasses = new Set();
  $('[class]').each((_, el) => {
    const classes = ($(el).attr('class') || '').split(/\s+/);
    classes.forEach((c) => c && allClasses.add(c));
  });
  const relevantClasses = [...allClasses].filter((c) =>
    /attend|falta|booking|absent|tick|cross|check|noatt|present|assist/i.test(c)
  );
  console.log('[AimHarder HTML] Clases relevantes encontradas:', relevantClasses.join(', ') || '(ninguna)');

  // También loguear todos los src de imágenes que puedan ser iconos de asistencia
  const imgSrcs = new Set();
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (/attend|falta|tick|cross|check|ok/i.test(src)) imgSrcs.add(src);
  });
  if (imgSrcs.size > 0) console.log('[AimHarder HTML] Imágenes de asistencia:', [...imgSrcs].join(', '));

  // Estrategia: buscar iconos de falta por clases o src de imagen
  const falseAttendSelectors = [
    '[class*="noAttend"]',
    '[class*="noattend"]',
    '[class*="falta"]',
    '[class*="absent"]',
    '[class*="notPresent"]',
    '[class*="missBooking"]',
    '.fa-times-circle',
    'img[src*="falta"]',
    'img[src*="cross"]',
    'img[src*="noattend"]',
    'img[src*="absent"]',
    'img[src*="times"]',
    // AimHarder puede usar íconos con datos específicos
    '[data-falta="1"]',
    '[data-attendance="0"]',
    '[data-assist="0"]',
  ];

  for (const sel of falseAttendSelectors) {
    const found = $(sel);
    if (found.length === 0) continue;

    console.log(`[AimHarder HTML] Selector "${sel}" encontró ${found.length} elementos`);

    found.each((_, el) => {
      const $el = $(el);
      // Subir al contenedor del booking para obtener el nombre
      const $row = $el.closest(
        '[class*="booking"], [class*="Booking"], [class*="attendee"], [class*="row"], [class*="user"]'
      );
      const memberName = $row
        .find('[class*="name"], [class*="Name"], [class*="user"], strong, b')
        .first()
        .text()
        .trim();

      if (!memberName) return;

      // Subir más para obtener la clase/horario
      const $classBlock = $el.closest(
        '[class*="classDiv"], [class*="class-block"], [class*="session"], [class*="Class"]'
      );
      const classTime = $classBlock.find('[class*="hour"], [class*="time"], [class*="schedule"]').first().text().trim();
      const className = $classBlock.find('h3, h4, [class*="name"]').first().text().trim();

      if (!absences.find((a) => a.memberName === memberName)) {
        absences.push({ memberName, classTime, className, date: dateStr });
      }
    });

    if (absences.length > 0) break;
  }

  return absences;
}

function splitFunctionArgs(raw) {
  const args = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  let depth = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const prev = raw[i - 1];

    if ((ch === '\'' || ch === '"') && prev !== '\\') {
      if (!inQuote) {
        inQuote = true;
        quoteChar = ch;
      } else if (quoteChar === ch) {
        inQuote = false;
        quoteChar = '';
      }
      current += ch;
      continue;
    }

    if (!inQuote && (ch === '(' || ch === '[' || ch === '{')) depth += 1;
    if (!inQuote && (ch === ')' || ch === ']' || ch === '}')) depth -= 1;

    if (!inQuote && depth === 0 && ch === ',') {
      args.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) args.push(current.trim());
  return args;
}

function decodeJsArg(value) {
  if (!value) return '';
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('\'') && trimmed.endsWith('\'')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed
      .slice(1, -1)
      .replace(/\\'/g, '\'')
      .replace(/\\"/g, '"')
      .replace(/#NL#/g, '\n');
  }
  return trimmed;
}

function extractContactFromOnclick(onclick) {
  const match = onclick && onclick.match(/previoCliente\((.*)\);?$/);
  if (!match) return { phone: '', email: '' };

  const args = splitFunctionArgs(match[1]).map(decodeJsArg);
  return {
    phone: args[8] || '',
    email: args[9] || '',
  };
}

function isCancelledWaitlistEntry($athlete, athleteText = '') {
  const normalizedText = String(athleteText).replace(/\s+/g, ' ').trim();
  const athleteHtml = ($athlete.html() || '').toLowerCase();
  const athleteClassName = String($athlete.attr('class') || '').toLowerCase();

  const hasCancelText =
    /cancelad[oa]s?/i.test(normalizedText) ||
    /anulad[oa]s?/i.test(normalizedText) ||
    /\bcancel(ar|ada|ado|aci[oó]n)\b/i.test(normalizedText);

  const hasCancelIcon =
    $athlete.find('.checkAthlete img[src*="delete2.svg"], .checkAthlete img[src*="delete"], .checkAthlete img[src*="cancel"]').length > 0;

  const hasCancelMarker =
    athleteClassName.includes('noassist') ||
    athleteHtml.includes('cancelado') ||
    athleteHtml.includes('anulad') ||
    athleteHtml.includes('delete2.svg');

  return hasCancelText || hasCancelIcon || hasCancelMarker;
}

function pushUniqueWaitlistMember(target, memberName) {
  const normalized = String(memberName || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

async function parseReservationsHtml(page, targetDate, scopeHtml = null) {
  const cheerio = require('cheerio');
  const html = scopeHtml || (await page.content());
  const $ = cheerio.load(html);
  const dateStr = toDateString(targetDate);
  const absences = [];

  $('.bloqueClase').each((_, classEl) => {
    const $class = $(classEl);
    const classTime = $class.find('.rvHora').first().text().trim();
    const className = $class.find('.rvNombreCl').first().text().trim();

    $class.find('.atletaClase').each((__, athleteEl) => {
      const $athlete = $(athleteEl);
      const absentIcon = $athlete.find('.checkAthlete img[src*="delete2.svg"]').first();
      if (!absentIcon.length) return;

      const memberName = $athlete.find('.atletaNom').first().text().replace(/\s+/g, ' ').trim();
      if (!memberName) return;

      const onclick =
        $athlete.find('.atletaNom').attr('onclick') ||
        $athlete.find('.atletaPic').attr('onclick') ||
        '';
      const { phone, email } = extractContactFromOnclick(onclick);

      absences.push({
        memberName,
        classTime,
        className,
        date: dateStr,
        phone: phone || '',
        email: email || '',
      });
    });
  });

  return absences;
}

function parseNumberMatch(text, regex) {
  const match = text.match(regex);
  if (!match) return null;
  return match.slice(1).map((value) => Number(value));
}

function extractTextByRegex(text, regex) {
  const match = text.match(regex);
  return match?.[1]?.trim() || '';
}

function extractInstructorNameFromText(text = '') {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  const markerIndex = normalized.toLowerCase().indexOf('instructor:');
  if (markerIndex === -1) return '';

  const afterMarker = normalized.slice(markerIndex + 'Instructor:'.length).trim();
  const stopMatch = afterMarker.match(/^(.*?)(?:\s{2,}|Plazas ocupadas|Asistencia|Detalle|Cancelar clase|$)/i);
  return stopMatch?.[1]?.trim() || afterMarker.trim();
}

function inferAlertColor(el) {
  const style = `${el.attribs?.style || ''} ${el.attribs?.class || ''}`.toLowerCase();
  if (/red|danger|error|rojo/.test(style)) return 'red';
  if (/blue|info|azul|primary/.test(style)) return 'blue';
  return 'neutral';
}

function isMetaClientLine(text) {
  return (
    /^reserva el/i.test(text) ||
    /^ultima reserva/i.test(text) ||
    /^última reserva/i.test(text) ||
    /^termina tarifa/i.test(text) ||
    /^alta:/i.test(text) ||
    /^clases:/i.test(text)
  );
}

async function parseReservationsHtmlForOccupancy(page, scopeHtml = null) {
  const cheerio = require('cheerio');
  const html = scopeHtml || (await page.content());
  const $ = cheerio.load(html);
  const classes = [];

  $('.bloqueClase').each((_, classEl) => {
    const $class = $(classEl);
    const text = $class.text().replace(/\s+/g, ' ').trim();
    const className = $class.find('.rvNombreCl').first().text().replace(/\s+/g, ' ').trim();
    const classTime = $class.find('.rvHora').first().text().replace(/\s+/g, ' ').trim();
    const roomName =
      extractTextByRegex(text, new RegExp(`${className}\\s+([^|]+?)\\s+\\|`, 'i')) ||
      '';
    const instructorName =
      extractInstructorNameFromText($class.find('.rvTop, .rvHead, .cabeceraClase').first().text()) ||
      extractInstructorNameFromText(text);

    const bookedMatch = parseNumberMatch(text, /Plazas ocupadas\s*(\d+)\s*\/\s*(\d+)/i);
    const waitlistHeaderMatch = text.match(/Plazas ocupadas\s*\d+\s*\/\s*\d+\s*\((\d+)\)/i);
    const attendanceMatch = parseNumberMatch(text, /Asistencia\s*(\d+)\s*\/\s*(\d+)/i);
    const athleteCards = $class.find('.atletaClase');
    const bookedCount = bookedMatch?.[0] ?? athleteCards.length;
    const capacity = bookedMatch?.[1] ?? attendanceMatch?.[1] ?? bookedCount;
    const waitlistMembers = [];

    let noShowCount = $class.find('.checkAthlete img[src*="delete2.svg"]').length;
    let attendanceCount =
      attendanceMatch?.[0] ??
      $class.find('.checkAthlete img[src*="check"], .checkAthlete img[src*="ok"], .checkAthlete img[src*="success"]').length;

    athleteCards.each((__, athleteEl) => {
      const $athlete = $(athleteEl);
      const athleteText = $athlete.text().replace(/\s+/g, ' ').trim();
      const isWaitlist =
        $athlete.closest('[class*="espera"], [class*="wait"], [id*="espera"], [id*="wait"], .waitList, .listaEspera').length > 0 ||
        /lista de espera/i.test(athleteText);

      if (!isWaitlist) return;
      if (isCancelledWaitlistEntry($athlete, athleteText)) return;

      const memberName = $athlete.find('.atletaNom').first().text().replace(/\s+/g, ' ').trim();
      pushUniqueWaitlistMember(waitlistMembers, memberName);
    });

    let inWaitlistSection = false;
    $class.children().each((__, childEl) => {
      const $child = $(childEl);
      const childText = $child.text().replace(/\s+/g, ' ').trim();

      if (!childText) return;

      if (/en lista de espera/i.test(childText)) {
        inWaitlistSection = true;
        return;
      }

      if (/cancelaciones/i.test(childText)) {
        inWaitlistSection = false;
        return;
      }

      if (!inWaitlistSection) return;

      const waitlistCards = $child.hasClass('atletaClase')
        ? $child
        : $child.find('.atletaClase');

      if (!waitlistCards.length) return;

      waitlistCards.each((___, waitlistEl) => {
        const $waitlistAthlete = $(waitlistEl);
        const waitlistText = $waitlistAthlete.text().replace(/\s+/g, ' ').trim();
        if (isCancelledWaitlistEntry($waitlistAthlete, waitlistText)) return;

        const memberName = $waitlistAthlete
          .find('.atletaNom')
          .first()
          .text()
          .replace(/\s+/g, ' ')
          .trim();

        pushUniqueWaitlistMember(waitlistMembers, memberName);
      });
    });

    if (!attendanceCount && bookedCount >= noShowCount) {
      attendanceCount = bookedCount - noShowCount;
    }

    if (attendanceCount > bookedCount && bookedCount > 0) {
      attendanceCount = bookedCount;
    }

    if (noShowCount === 0 && bookedCount >= attendanceCount) {
      noShowCount = bookedCount - attendanceCount;
    }

    const waitlistCountFromHeader = waitlistHeaderMatch ? Number(waitlistHeaderMatch[1]) || 0 : 0;
    const waitlistCount = Math.max(waitlistMembers.length, waitlistCountFromHeader);

    if (!className && !classTime) return;

    classes.push({
      className,
      classTime,
      instructorName,
      roomName,
      bookedCount,
      attendanceCount,
      noShowCount,
      waitlistCount,
      waitlistMembers,
      capacity,
      occupancyRate: formatPercent(bookedCount, capacity),
      attendanceRate: formatPercent(attendanceCount, capacity),
    });
  });

  return classes.sort((a, b) => a.classTime.localeCompare(b.classTime));
}

async function parseReservationsHtmlForClassReports(page, scopeHtml = null) {
  const cheerio = require('cheerio');
  // `scopeHtml` es el listado del día pedido. Sin él se leería `.bloqueClase` de
  // todo el documento, que puede contener también las clases de otros días.
  const html = scopeHtml || (await page.content());
  const $ = cheerio.load(html);
  const classes = [];

  $('.bloqueClase').each((_, classEl) => {
    const $class = $(classEl);
    const classText = $class.text().replace(/\s+/g, ' ').trim();
    const className = $class.find('.rvNombreCl').first().text().replace(/\s+/g, ' ').trim();
    const classTime = $class.find('.rvHora').first().text().replace(/\s+/g, ' ').trim();
    const instructorName =
      extractInstructorNameFromText($class.find('.rvTop, .rvHead, .cabeceraClase').first().text()) ||
      extractInstructorNameFromText(classText);
    const members = [];
    const nodeOrder = new Map($class.find('*').toArray().map((node, index) => [node, index]));
    const cancellationMarker = $class
      .find('*')
      .filter((__, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (!text || !/cancelaciones/i.test(text)) return false;
        if ($(el).find('.atletaClase').length) return false;

        return /(?:^|[^a-zA-Z])\d+\s*cancelaciones\b/i.test(text);
      })
      .first();
    const cancellationMarkerIndex = cancellationMarker.length
      ? nodeOrder.get(cancellationMarker.get(0)) ?? Number.POSITIVE_INFINITY
      : Number.POSITIVE_INFINITY;

    if (/open/i.test(className)) return;

    const memberCards = $class.find('.atletaClase').length
      ? $class.find('.atletaClase').toArray()
      : $class
          .find('.atletaNom')
          .map((__, el) => {
            const $name = $(el);
            return (
              $name.closest('.atletaClase, .clienteClase, .atletaFila, .filaCliente, li, article, .grid-item, .col').get(0) ||
              $name.parent().get(0) ||
              $name.closest('div').get(0)
            );
          })
          .get()
          .filter(Boolean);

    memberCards.forEach((athleteEl) => {
      const $athlete = $(athleteEl);
      const athleteIndex = nodeOrder.get(athleteEl);

      // Si aparece el bloque "X CANCELACIONES", solo se procesan clientes por encima de ese separador.
      if (
        Number.isFinite(cancellationMarkerIndex) &&
        Number.isFinite(athleteIndex) &&
        athleteIndex > cancellationMarkerIndex
      ) {
        return;
      }

      const waitlistContainer = $athlete.closest(
        '[class*="espera"], [class*="wait"], [id*="espera"], [id*="wait"], .waitList, .listaEspera'
      );
      if (waitlistContainer.length) return;

      const memberName = (
        $athlete.find('.atletaNom').first().text() ||
        $athlete
          .contents()
          .filter((__, node) => node.type === 'text')
          .text()
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (!memberName) return;

      const athleteText = $athlete.text().replace(/\s+/g, ' ').trim();
      if (/lista de espera/i.test(athleteText)) return;
      if (isCancelledWaitlistEntry($athlete, athleteText)) return;

      const alerts = [];
      $athlete.find('*').each((___, childEl) => {
        const $child = $(childEl);
        const text = $child.text().replace(/\s+/g, ' ').trim();
        if (!text || text === memberName || isMetaClientLine(text)) return;
        if (text.length > 120) return;
        if (/lista de espera/i.test(text)) return;

        const alert = {
          text,
          color: inferAlertColor(childEl),
        };

        if (!alerts.find((item) => item.text === alert.text)) {
          alerts.push(alert);
        }
      });

      if (!members.find((item) => item.memberName === memberName)) {
        members.push({
          memberName,
          alerts,
        });
      }
    });

    if (!className || !classTime || !instructorName) return;

    classes.push({
      className,
      classTime,
      instructorName,
      period: getPeriodByTime(classTime),
      members,
    });
  });

  return classes.sort((a, b) => a.classTime.localeCompare(b.classTime));
}

function toMinutes(time = '') {
  const [hours, minutes] = String(time).split(':').map((value) => Number(value || 0));
  return (hours * 60) + minutes;
}

async function getClassReportContext(dateStr = null, centerId, userName = '', isAdmin = false, userId = null, options = {}) {
  const config = await getCenterAimHarderConfig(centerId);
  const username = config.username;
  const password = config.password;

  if (!username || !password) {
    throw new Error(`Faltan credenciales de AimHarder para ${config.centerName}. Configúralas en la integración del centro.`);
  }

  const targetDate = dateStr ? new Date(`${dateStr}T12:00:00`) : new Date();
  const targetDateStr = toDateString(targetDate);

  // Modo depuración: capturas (base64) de cada paso, para ver desde la web
  // en qué punto se queda atascado el scraping.
  const debug = Boolean(options.debug);
  const debugSteps = [];
  const browser = await chromium.launch({ headless: true, slowMo: 0 });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const sessionCache = await getSessionCache(config);
    if (sessionCache.cookies && sessionCache.expiry && Date.now() < sessionCache.expiry) {
      await context.addCookies(sessionCache.cookies);
    }

    const page = await context.newPage();
    const ajaxPayloads = [];
    page.on('response', async (response) => {
      try {
        const request = response.request();
        const resourceType = request.resourceType();
        if (!['xhr', 'fetch'].includes(resourceType)) return;
        const contentType = String(response.headers()['content-type'] || '').toLowerCase();
        if (!contentType.includes('json') && !contentType.includes('text')) return;
        const body = await response.text();
        if (body && body.length < 300000) {
          ajaxPayloads.push(body);
        }
      } catch {
        // ignore network parsing issues
      }
    });
    await ensureAuthenticatedSession(page, config);

    await setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    const snap = async (label, nota = null) => {
      if (!debug) return;
      try {
        const buffer = await page.screenshot({ fullPage: true });
        debugSteps.push({
          label,
          url: page.url(),
          image: `data:image/png;base64,${buffer.toString('base64')}`,
          ...(nota ? { error: nota } : {}),
        });
      } catch (e) {
        debugSteps.push({ label, url: page.url(), error: nota ? `${nota}\n(${e.message})` : e.message });
      }
    };

    let navegacion = null;
    try {
      navegacion = await openReservationsDay(page, targetDate, config, snap);
    } catch (e) {
      // En depuración interesan las capturas aunque falle: se adjuntan al error.
      if (debug) { e.debugSteps = debugSteps; }
      throw e;
    }
    const reservationClasses = navegacion && navegacion.bookings
      ? parseCoachBookingsJson(navegacion.bookings)
      : await parseReservationsHtmlForClassReports(page, navegacion && navegacion.scopeHtml);
    const userNameCandidates = Array.isArray(userName) ? userName : [userName];
    const normalizedUserNames = userNameCandidates
      .map((value) => normalizeName(value))
      .filter(Boolean);
    const now = new Date();
    const nowMinutes = (now.getHours() * 60) + now.getMinutes();
    const isToday = targetDateStr === toDateString(new Date());

    const filteredClasses = isAdmin
      ? reservationClasses
      : reservationClasses.filter((item) => {
          return normalizedUserNames.some((candidate) => namesLikelyMatch(item.instructorName, candidate));
        });

    const savedReports = await ClassReport.find({ center: centerId, date: targetDateStr }).lean();
    const savedMap = new Map(
      savedReports.map((report) => [`${normalizeName(report.instructorName)}::${report.period}`, report])
    );

    const grouped = new Map();

    for (const classItem of filteredClasses) {
      const key = `${normalizeName(classItem.instructorName)}::${classItem.period}`;
      const existing = grouped.get(key) || {
        instructorName: classItem.instructorName,
        period: classItem.period,
        classes: [],
      };
      existing.classes.push(classItem);
      grouped.set(key, existing);
    }

    // Suelo de seguridad: una clase que YA tiene avisos anotados nunca puede
    // desaparecer porque el scrapeo no la devuelva. Se añade reconstruida a
    // partir de lo guardado (clientes incluidos) y se reordena por hora.
    for (const saved of savedReports) {
      if (!isAdmin && !normalizedUserNames.some((candidate) => namesLikelyMatch(saved.instructorName, candidate))) {
        continue;
      }
      const key = `${normalizeName(saved.instructorName)}::${saved.period}`;
      const group = grouped.get(key) || {
        instructorName: saved.instructorName,
        period: saved.period,
        classes: [],
      };
      const presentes = new Set(group.classes.map((c) => buildSavedClassKey(c.classTime, c.className)));

      const guardadas = new Map();
      for (const guardada of saved.savedClasses || []) {
        guardadas.set(buildSavedClassKey(guardada.classTime, guardada.className), guardada);
      }
      for (const item of saved.items || []) {
        const clave = buildSavedClassKey(item.classTime, item.className);
        if (!guardadas.has(clave)) guardadas.set(clave, item);
      }

      for (const [clave, clase] of guardadas) {
        if (!clase.classTime || !clase.className || presentes.has(clave)) continue;
        const miembros = (saved.items || [])
          .filter((item) => buildSavedClassKey(item.classTime, item.className) === clave && item.memberName)
          .map((item) => ({ memberName: item.memberName, alerts: [] }));
        group.classes.push({
          className: clase.className,
          classTime: clase.classTime,
          instructorName: saved.instructorName,
          period: saved.period,
          members: miembros,
        });
      }

      group.classes.sort((a, b) => toMinutes(a.classTime) - toMinutes(b.classTime));
      grouped.set(key, group);
    }

    return {
      date: targetDateStr,
      ...(debug ? { debug: { steps: debugSteps } } : {}),
      reports: Array.from(grouped.values()).map((group) => {
        const latestMinutes = Math.max(...group.classes.map((item) => toMinutes(item.classTime)));
        const ready = !isToday || latestMinutes <= nowMinutes;
        const saved = savedMap.get(`${normalizeName(group.instructorName)}::${group.period}`);
        const savedItems = new Map(
          (saved?.items || []).map((item) => [
            `${normalizeClassTime(item.classTime)}::${normalizeName(item.className)}::${normalizeName(item.memberName)}`,
            item,
          ])
        );
        const savedClasses = new Map(
          (saved?.savedClasses || []).map((savedClass) => [
            buildSavedClassKey(savedClass.classTime, savedClass.className),
            savedClass,
          ])
        );
        const hasLegacyWholeReportCompletion =
          savedClasses.size === 0 &&
          Boolean(saved?.submittedAt || saved?.updatedAt) &&
          Array.isArray(saved?.items) &&
          saved.items.length > 0;

        return {
          instructorName: group.instructorName,
          period: group.period,
          ready,
          latestClassTime: group.classes[group.classes.length - 1]?.classTime || '',
          submittedAt: saved?.submittedAt || null,
          updatedAt: saved?.updatedAt || null,
          updatedBy: saved?.updatedBy || null,
          classes: group.classes.map((classItem) => ({
            className: classItem.className,
            classTime: classItem.classTime,
            saved: hasLegacyWholeReportCompletion || savedClasses.has(buildSavedClassKey(classItem.classTime, classItem.className)),
            comment: savedClasses.get(buildSavedClassKey(classItem.classTime, classItem.className))?.comment || '',
            savedAt:
              savedClasses.get(buildSavedClassKey(classItem.classTime, classItem.className))?.savedAt ||
              (hasLegacyWholeReportCompletion ? saved?.submittedAt || saved?.updatedAt || null : null),
            members: classItem.members.map((member) => {
              const savedItem = savedItems.get(
                `${normalizeClassTime(classItem.classTime)}::${normalizeName(classItem.className)}::${normalizeName(member.memberName)}`
              );
              return {
                memberName: member.memberName,
                alerts: member.alerts || [],
                note: savedItem?.note || '',
                handoffDone: !!savedItem?.handoffDone,
                handoffDoneAt: savedItem?.handoffDoneAt || null,
                handoffDoneBy: savedItem?.handoffDoneBy || null,
              };
            }),
          })),
        };
      }),
    };
  } finally {
    await browser.close();
  }
}

// Clases ya anotadas ese día, leídas de ClassReport. Sirven de suelo del
// seguimiento: lo que ya tiene avisos escritos no puede desaparecer del listado
// por un scrapeo que devuelva menos clases.
async function clasesYaAnotadas(centerId, date) {
  const informes = await ClassReport.find({ center: centerId, date }).lean();
  const filas = [];
  for (const informe of informes) {
    const clases = new Map();
    for (const guardada of informe.savedClasses || []) {
      clases.set(buildSavedClassKey(guardada.classTime, guardada.className), guardada);
    }
    for (const item of informe.items || []) {
      const clave = buildSavedClassKey(item.classTime, item.className);
      if (!clases.has(clave)) clases.set(clave, item);
    }
    for (const clase of clases.values()) {
      if (!clase.classTime || !clase.className) continue;
      filas.push({
        instructorName: informe.instructorName,
        period: informe.period,
        className: clase.className,
        classTime: clase.classTime,
      });
    }
  }
  return filas;
}

async function upsertClassReportRoster(centerId, date, reports = []) {
  const scrapeadas = reports.flatMap((report) =>
    (report.classes || []).map((classItem) => ({
      instructorName: report.instructorName,
      period: report.period,
      className: classItem.className,
      classTime: classItem.classTime,
    }))
  );

  // Unión con lo ya anotado. Sin esto, refrescar el seguimiento de un día
  // pasado borraba instructores que SÍ tenían avisos guardados (era el caso de
  // "me he puesto como instructor en una clase de ayer y me los ha quitado
  // todos"). El scrapeo puede añadir, nunca quitar trabajo ya hecho.
  const yaAnotadas = await clasesYaAnotadas(centerId, date);
  const porClave = new Map();
  for (const fila of [...scrapeadas, ...yaAnotadas]) {
    if (!fila.instructorName || !fila.classTime || !fila.className) continue;
    porClave.set(
      `${normalizeName(fila.instructorName)}::${fila.period}::${buildSavedClassKey(fila.classTime, fila.className)}`,
      fila
    );
  }
  const instructors = Array.from(porClave.values());

  return ClassReportRoster.findOneAndUpdate(
    { center: centerId, date },
    {
      $set: {
        center: centerId,
        date,
        instructors,
        refreshedAt: new Date(),
        // Solo se llega aquí con un contexto scrapeado, y el contexto solo se
        // devuelve si `openReservationsDay` verificó el día en el DOM.
        verified: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function getClassReportStatus(dateStr = null, centerId, options = {}) {
  const targetDate = dateStr || toDateString(new Date());
  const { initialize = false, forceRefresh = false } = options;

  let roster = await ClassReportRoster.findOne({ center: centerId, date: targetDate }).lean();
  const rosterInstructors = (roster && roster.instructors) || [];
  const rosterHasIncompleteEntries = rosterInstructors.some((entry) => !entry.classTime || !entry.className);
  // Un roster vacío se quedaba clavado para siempre: `some()` sobre [] es false,
  // así que no se consideraba "a refrescar" y, al existir el documento, tampoco
  // entraba por la rama de `!roster`. Pasaba con días aún sin clases publicadas
  // (p. ej. una fecha futura) o con un scrapeo fallido. Se reintenta, pero solo
  // si ya tiene un rato, para no lanzar un navegador en cada carga de la página.
  const EMPTY_ROSTER_RETRY_MS = 10 * 60 * 1000;
  const rosterIsStaleEmpty = Boolean(roster)
    && rosterInstructors.length === 0
    && (!roster.refreshedAt || (Date.now() - new Date(roster.refreshedAt).getTime()) > EMPTY_ROSTER_RETRY_MS);
  // Un roster de un día pasado guardado ANTES de que el scrapeo supiera
  // verificar la fecha puede ser el listado de otro día (de ahí los
  // instructores con un número de clases que no cuadra). No se enseña: se
  // vuelve a intentar y, si no se puede, se reconstruye con lo ya anotado.
  const esHoy = targetDate === toDateString(new Date());
  const rosterNoFiable = Boolean(roster) && roster.verified !== true && !esHoy;
  const rosterNeedsRefresh = rosterHasIncompleteEntries || rosterIsStaleEmpty || rosterNoFiable;
  if ((forceRefresh || ((!roster || rosterNeedsRefresh) && initialize))) {
    try {
      const context = await getClassReportContext(targetDate, centerId, '', true, null);
      roster = (await upsertClassReportRoster(centerId, context.date, context.reports || [])).toObject();
    } catch (err) {
      // Si el scrapeo falla (p. ej. AimHarder no deja abrir ese día) NO se puede
      // dejar al usuario sin seguimiento: se reconstruye el listado a partir de
      // los avisos YA anotados de ese día, que viven en ClassReport. No se guarda
      // como roster para no dar por bueno un listado parcial.
      const reconstruido = await clasesYaAnotadas(centerId, targetDate);

      // Si no hay nada anotado y el roster guardado no es de fiar, se prefiere
      // el error a enseñar las clases de otro día.
      if (reconstruido.length === 0) throw err;

      console.warn(
        `[AimHarder] Scrapeo de ${targetDate} fallido (${err.message}). ` +
        `Se muestra el seguimiento reconstruido con ${reconstruido.length} clases ya anotadas.`
      );
      roster = { instructors: reconstruido, refreshedAt: null, verified: false, rebuiltFromReports: true };
    }
  }

  // Última red: si tras todo seguimos con un roster sin verificar de un día
  // pasado, se muestra solo lo que ya está anotado, nunca el listado dudoso.
  if (roster && roster.verified !== true && !roster.rebuiltFromReports && !esHoy) {
    roster = {
      instructors: await clasesYaAnotadas(centerId, targetDate),
      refreshedAt: null,
      verified: false,
      rebuiltFromReports: true,
    };
  }

  if (!roster) {
    return {
      date: targetDate,
      done: false,
      totalInstructors: 0,
      completedInstructors: 0,
      instructors: [],
      rosterRefreshedAt: null,
      initialized: false,
    };
  }

  const savedReports = await ClassReport.find({ center: centerId, date: targetDate }).lean();
  const reportMap = new Map(
    savedReports.map((report) => [
      `${normalizeName(report.instructorName)}::${report.period}`,
      report,
    ])
  );

  const grouped = new Map();
  for (const entry of roster.instructors || []) {
    const report = reportMap.get(`${normalizeName(entry.instructorName)}::${entry.period}`);
    const savedClasses = new Set((report?.savedClasses || []).map((savedClass) => buildSavedClassKey(savedClass.classTime, savedClass.className)));
    const hasLegacyWholeReportCompletion =
      savedClasses.size === 0 &&
      Boolean(report?.submittedAt || report?.updatedAt) &&
      Array.isArray(report?.items) &&
      report.items.length > 0;
    const key = normalizeName(entry.instructorName);
    const existing = grouped.get(key) || {
      instructorName: entry.instructorName,
      totalGroups: 0,
      completedGroups: 0,
      totalClasses: 0,
      completedClasses: 0,
      done: false,
    };

    existing.totalGroups += 1;
    existing.totalClasses += 1;
    if (hasLegacyWholeReportCompletion || savedClasses.has(buildSavedClassKey(entry.classTime, entry.className))) {
      existing.completedGroups += 1;
      existing.completedClasses += 1;
    }
    existing.done = existing.totalGroups > 0 && existing.completedGroups === existing.totalGroups;
    grouped.set(key, existing);
  }

  const instructors = Array.from(grouped.values()).sort((a, b) =>
    a.instructorName.localeCompare(b.instructorName, 'es')
  );
  const completedInstructors = instructors.filter((item) => item.done).length;

  return {
    date: targetDate,
    done: instructors.length === 0 || completedInstructors === instructors.length,
    totalInstructors: instructors.length,
    completedInstructors,
    instructors,
    rosterRefreshedAt: roster.refreshedAt || roster.updatedAt || null,
    initialized: true,
  };
}

async function saveClassReport(data) {
  const {
    centerId,
    date,
    period,
    instructorName,
    instructorUserId = null,
    updatedBy,
    items = [],
    completedClasses = [],
  } = data;

  const targetDate = date || toDateString(new Date());
  const existingReport = await ClassReport.findOne({
    center: centerId,
    date: targetDate,
    instructorName: String(instructorName || '').trim(),
    period,
  }).lean();

  const existingItems = new Map(
    (existingReport?.items || []).map((item) => [
      `${normalizeClassTime(item.classTime)}::${normalizeName(item.className)}::${normalizeName(item.memberName)}`,
      item,
    ])
  );

  const normalizedCompletedClasses = completedClasses
    .map((classItem) => ({
      className: String(classItem.className || '').trim(),
      classTime: String(classItem.classTime || '').trim(),
      // undefined => no se tocó el comentario en esta petición (se preserva el existente).
      comment: classItem.comment !== undefined ? String(classItem.comment || '').trim() : undefined,
    }))
    .filter((classItem) => classItem.className && classItem.classTime);

  if (normalizedCompletedClasses.length === 0) {
    const derivedClasses = new Map();
    for (const item of items) {
      const className = String(item.className || '').trim();
      const classTime = String(item.classTime || '').trim();
      if (!className || !classTime) continue;
      derivedClasses.set(buildSavedClassKey(classTime, className), { className, classTime });
    }
    normalizedCompletedClasses.push(...derivedClasses.values());
  }

  const completedClassKeys = new Set(
    normalizedCompletedClasses.map((classItem) => buildSavedClassKey(classItem.classTime, classItem.className))
  );

  const normalizedItems = items
    .map((item) => ({
      className: String(item.className || '').trim(),
      classTime: String(item.classTime || '').trim(),
      memberName: String(item.memberName || '').trim(),
      note: String(item.note || '').trim(),
    }))
    .filter((item) => item.className && item.classTime && item.memberName && item.note)
    .map((item) => {
      const existingItem = existingItems.get(
        `${normalizeClassTime(item.classTime)}::${normalizeName(item.className)}::${normalizeName(item.memberName)}`
      );
      const sameNote = existingItem && String(existingItem.note || '').trim() === item.note;

      return {
        ...item,
        handoffDone: sameNote ? !!existingItem.handoffDone : false,
        handoffDoneBy: sameNote ? existingItem.handoffDoneBy || null : null,
        handoffDoneAt: sameNote ? existingItem.handoffDoneAt || null : null,
      };
    });

  const preservedItems = (existingReport?.items || []).filter(
    (item) => !completedClassKeys.has(buildSavedClassKey(item.classTime, item.className))
  );

  const mergedItems = [...preservedItems, ...normalizedItems];

  const savedClassesMap = new Map(
    (existingReport?.savedClasses || []).map((savedClass) => [
      buildSavedClassKey(savedClass.classTime, savedClass.className),
      savedClass,
    ])
  );

  for (const classItem of normalizedCompletedClasses) {
    const savedClassKey = buildSavedClassKey(classItem.classTime, classItem.className);
    const existingSavedClass = savedClassesMap.get(savedClassKey);
    savedClassesMap.set(savedClassKey, {
      className: classItem.className,
      classTime: classItem.classTime,
      comment: classItem.comment !== undefined ? classItem.comment : (existingSavedClass?.comment || ''),
      savedBy: updatedBy,
      savedAt: new Date(),
    });
  }

  const report = await ClassReport.findOneAndUpdate(
    {
      center: centerId,
      date: targetDate,
      instructorName: String(instructorName || '').trim(),
      period,
    },
    {
      $set: {
        center: centerId,
        date: targetDate,
        instructorName: String(instructorName || '').trim(),
        instructorUser: instructorUserId || null,
        period,
        items: mergedItems,
        savedClasses: Array.from(savedClassesMap.values()),
        updatedBy,
        submittedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return report;
}

async function resetClassReportTask(data) {
  const {
    centerId,
    date,
    instructorName,
  } = data;

  const targetDate = date || toDateString(new Date());
  const normalizedInstructorName = String(instructorName || '').trim();

  if (!centerId || !normalizedInstructorName) {
    throw new Error('centerId e instructorName son obligatorios');
  }

  const result = await ClassReport.deleteMany({
    center: centerId,
    date: targetDate,
    instructorName: normalizedInstructorName,
  });

  return {
    date: targetDate,
    instructorName: normalizedInstructorName,
    deletedCount: result.deletedCount || 0,
  };
}

async function setClassReportHandoffStatus(data) {
  const { centerId, date, period, instructorName, className, classTime, memberName, done, updatedBy } = data;
  const targetDate = date || toDateString(new Date());
  const report = await ClassReport.findOne({
    center: centerId,
    date: targetDate,
    instructorName: String(instructorName || '').trim(),
    period,
  });

  if (!report) return null;

  const targetItem = report.items.find(
    (item) =>
      item.className === String(className || '').trim() &&
      item.classTime === String(classTime || '').trim() &&
      item.memberName === String(memberName || '').trim()
  );

  if (!targetItem) return null;

  targetItem.handoffDone = !!done;
  targetItem.handoffDoneBy = done ? updatedBy : null;
  targetItem.handoffDoneAt = done ? new Date() : null;
  report.updatedBy = updatedBy;
  await report.save();
  return report;
}

async function fetchAimHarderClientsPage(page, config) {
  let accessToken = await getAimHarderApiAccessToken(config);
  let response = await aimharderApiRequest(`/clients?page=${page}`, accessToken);

  if (response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 410) {
    accessToken = await refreshAimHarderApiTokens(config);
    response = await aimharderApiRequest(`/clients?page=${page}`, accessToken);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`AimHarder API /clients devolvió ${response.statusCode}`);
  }

  return response.body;
}

function mapAimHarderClientToActiveClient(client, reportDate, centerId) {
  const fullName = [client.name, client.first_surname, client.second_surname]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const phone = client.mobile_number || client.land_number || '';

  return {
    center: centerId,
    aimharderId: String(client.id || ''),
    name: fullName,
    normalizedName: normalizeName(fullName),
    phone,
    email: client.email || '',
    locality: client.city || '',
    activeMembership: '',
    membershipStartDate: '',
    joinDate: client.creation_date || '',
    reportDate,
  };
}

async function syncActiveClientsViaApi(reportDate = toDateString(new Date()), config) {
  console.log(`[AimHarder API] ===== Sincronizando clientes para ${config.centerName} en ${reportDate} =====`);
  const clients = [];
  let page = 1;
  let totalPages = 1;

  do {
    const body = await fetchAimHarderClientsPage(page, config);
    const pageClients = unwrapAimHarderListResponse(body);
    clients.push(...pageClients);

    const pagination = body?.pagination;
    totalPages = pagination?.totalPages || pagination?.total_pages || (pageClients.length > 0 ? page : 0);
    page += 1;
  } while (page <= totalPages);

  const mapped = clients
    .map((client) => mapAimHarderClientToActiveClient(client, reportDate, config.centerId))
    .filter((client) => client.name);

  const result = await upsertActiveClients(mapped, reportDate, config.centerId);
  console.log(`[AimHarder API] ${result.inserted} clientes sincronizados`);
  return mapped;
}

async function upsertActiveClients(clients, reportDate, centerId) {
  if (!clients.length) return { inserted: 0 };

  const ops = clients.map((client) => ({
    updateOne: {
      filter: { center: centerId, reportDate, normalizedName: client.normalizedName },
      update: {
        $set: {
          ...client,
          lastSyncedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await ActiveClient.bulkWrite(ops, { ordered: false });
  return { inserted: clients.length };
}

async function ensureActiveClientsSyncedToday(config) {
  const today = toDateString(new Date());
  const existing = await ActiveClient.exists({ center: config.centerId, reportDate: today });
  if (existing) {
    console.log('[AimHarder API] Clientes ya sincronizados hoy');
    return;
  }
  await syncActiveClientsViaApi(today, config);
}

async function enrichAbsencesFromDb(absences, centerId) {
  if (!absences.length) return absences;

  const normalizedNames = absences.map((absence) => normalizeName(absence.memberName));
  const clients = await ActiveClient.find({ center: centerId, normalizedName: { $in: normalizedNames } })
    .sort({ reportDate: -1, updatedAt: -1 })
    .lean();

  const byName = new Map();
  for (const client of clients) {
    if (!byName.has(client.normalizedName)) {
      byName.set(client.normalizedName, client);
    }
  }

  return absences.map((absence) => {
    const client = byName.get(normalizeName(absence.memberName));
    if (!client) return absence;
    return {
      ...absence,
      phone: absence.phone || client.phone || '',
      email: absence.email || client.email || '',
      activeMembership: client.activeMembership || '',
      membershipStartDate: client.membershipStartDate || '',
      joinDate: client.joinDate || '',
    };
  });
}

async function storeAbsences(dateStr, absences, centerId) {
  await AttendanceAbsenceSnapshot.findOneAndUpdate(
    { center: centerId, date: dateStr },
    {
      $set: {
        center: centerId,
        date: dateStr,
        absences,
        refreshedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );
}

async function storeOccupancy(dateStr, classes, centerId) {
  await CenterOccupancySnapshot.findOneAndUpdate(
    { center: centerId, date: dateStr },
    {
      $set: {
        center: centerId,
        date: dateStr,
        classes,
        refreshedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );
}

async function getStoredAbsences(dateStr = null, centerId) {
  const targetDate = dateStr || toDateString(getYesterday());
  const snapshot = await AttendanceAbsenceSnapshot.findOne({ center: centerId, date: targetDate }).lean();
  return snapshot?.absences || [];
}

async function getAbsenceSnapshotsRange(startDateStr, endDateStr, centerId) {
  const snapshots = await AttendanceAbsenceSnapshot.find({
    center: centerId,
    date: { $gte: startDateStr, $lte: endDateStr },
  })
    .sort({ date: 1 })
    .lean();
  return snapshots.map((s) => ({ date: s.date, absences: s.absences || [] }));
}

async function getStoredOccupancy(startDateStr = null, endDateStr = null, centerId) {
  if (startDateStr && endDateStr) {
    const snapshots = await CenterOccupancySnapshot.find({
      center: centerId,
      date: { $gte: startDateStr, $lte: endDateStr },
    })
      .sort({ date: 1 })
      .lean();
    return snapshots.map((snapshot) => ({
      date: snapshot.date,
      refreshedAt: snapshot.refreshedAt,
      classes: snapshot.classes || [],
    }));
  }

  const targetDate = startDateStr || toDateString(new Date());
  const snapshot = await CenterOccupancySnapshot.findOne({ center: centerId, date: targetDate }).lean();
  return snapshot
    ? [{ date: snapshot.date, refreshedAt: snapshot.refreshedAt, classes: snapshot.classes || [] }]
    : [];
}

// ─────────────────────────────────────────────────────
// Función principal
// ─────────────────────────────────────────────────────

async function getAbsences(dateStr = null, centerId) {
  const config = await getCenterAimHarderConfig(centerId);
  const username = config.username;
  const password = config.password;

  if (!username || !password) {
    throw new Error(
      `Faltan credenciales de AimHarder para ${config.centerName}. Configura ${config.envPrefix}USERNAME y ${config.envPrefix}PASSWORD en el .env`
    );
  }

  const targetDate = dateStr ? new Date(dateStr + 'T12:00:00') : getYesterday();
  console.log(`[AimHarder] ===== Iniciando scraping para ${toDateString(targetDate)} =====`);

  const browser = await chromium.launch({
    headless: true,
    slowMo: 0,
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    // Restaurar sesión si está en caché
    const sessionCache = await getSessionCache(config);
    if (sessionCache.cookies && sessionCache.expiry && Date.now() < sessionCache.expiry) {
      await context.addCookies(sessionCache.cookies);
      console.log('[AimHarder] Sesión restaurada desde caché');
    }

    const page = await context.newPage();

    // ── Interceptar TODAS las respuestas JSON ──
    const interceptedJsonList = [];
    page.on('response', async (response) => {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('application/json') && !ct.includes('text/json')) return;
      try {
        const json = await response.json();
        interceptedJsonList.push({ url: response.url(), data: json });
        console.log('[AimHarder AJAX]', response.url());
      } catch {}
    });

    // ── Reutilizar sesión o login ──
    await ensureAuthenticatedSession(page, config);

    // ── Sincronizar clientes activos una vez al día ──
    try {
      await ensureActiveClientsSyncedToday(config);
    } catch (error) {
      console.warn('[AimHarder] No se pudo sincronizar clientes activos:', error.message);
    }

    // Guardar cookies actualizadas
    await setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    // ── Navegación al día ──
    const navAusencias = await openReservationsDay(page, targetDate, config);
    await saveDebugSnapshot(page, '06_final_schedule');

    const reservationAbsences = await parseReservationsHtml(page, targetDate, navAusencias && navAusencias.scopeHtml);
    if (reservationAbsences.length > 0) {
      console.log(`[AimHarder] ${reservationAbsences.length} ausencias encontradas en Reservas`);
      return enrichAbsencesFromDb(reservationAbsences, config.centerId);
    }
    console.log('[AimHarder] No se encontraron ausencias en el HTML de Reservas, probando JSON/fallback...');

    // ── Parseo: JSON interceptado (más fiable) ──
    if (interceptedJsonList.length > 0) {
      console.log(`[AimHarder] ${interceptedJsonList.length} respuestas JSON interceptadas`);
      for (const { url, data } of interceptedJsonList) {
        const absences = parseBookingsJson(data, targetDate);
        if (absences.length > 0) {
          console.log(`[AimHarder] ${absences.length} ausencias encontradas en ${url}`);
          return enrichAbsencesFromDb(absences, config.centerId);
        }
      }
      console.log('[AimHarder] JSON interceptado no contenía ausencias reconocibles, intentando HTML...');
    } else {
      console.log('[AimHarder] No se interceptaron respuestas JSON, intentando HTML...');
    }

    // ── Parseo: HTML (fallback) ──
    const htmlAbsences = await parseHtmlForAbsences(page, targetDate);
    console.log(`[AimHarder] ${htmlAbsences.length} ausencias encontradas via HTML`);
    return enrichAbsencesFromDb(htmlAbsences, config.centerId);
  } finally {
    await browser.close();
    console.log('[AimHarder] ===== Scraping finalizado =====');
  }
}

async function refreshAndStoreAbsences(dateStr = null, centerId) {
  const targetDate = dateStr || toDateString(getYesterday());
  const absences = await getAbsences(targetDate, centerId);
  await storeAbsences(targetDate, absences, centerId);
  return absences;
}

async function getOccupancy(dateStr = null, centerId) {
  const config = await getCenterAimHarderConfig(centerId);
  const username = config.username;
  const password = config.password;

  if (!username || !password) {
    throw new Error(
      `Faltan credenciales de AimHarder para ${config.centerName}. Configura ${config.envPrefix}USERNAME y ${config.envPrefix}PASSWORD en el .env`
    );
  }

  const targetDate = dateStr ? new Date(dateStr + 'T12:00:00') : new Date();
  const targetDateStr = toDateString(targetDate);
  console.log(`[AimHarder] ===== Iniciando carga de ocupación para ${targetDateStr} =====`);

  const browser = await chromium.launch({
    headless: true,
    slowMo: 0,
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const sessionCache = await getSessionCache(config);
    if (sessionCache.cookies && sessionCache.expiry && Date.now() < sessionCache.expiry) {
      await context.addCookies(sessionCache.cookies);
      console.log('[AimHarder] Sesión restaurada desde caché');
    }

    const page = await context.newPage();
    await ensureAuthenticatedSession(page, config);

    await setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    const navOcupacion = await openReservationsDay(page, targetDate, config);
    const classes = navOcupacion && navOcupacion.bookings
      ? occupancyFromCoachBookings(navOcupacion.bookings)
      : await parseReservationsHtmlForOccupancy(page, navOcupacion && navOcupacion.scopeHtml);
    console.log(`[AimHarder] ${classes.length} clases encontradas para ocupación`);
    return { date: targetDateStr, classes };
  } finally {
    await browser.close();
    console.log('[AimHarder] ===== Carga de ocupación finalizada =====');
  }
}

async function refreshAndStoreOccupancy(dateStr = null, centerId) {
  const { date, classes } = await getOccupancy(dateStr, centerId);
  await storeOccupancy(date, classes, centerId);
  return { date, classes };
}

async function refreshAndStoreOccupancyRange(startDateStr, endDateStr, centerId) {
  if (!startDateStr || !endDateStr) {
    throw new Error('Se requieren startDate y endDate para refrescar un rango de ocupación');
  }

  const start = new Date(`${startDateStr}T12:00:00`);
  const end = new Date(`${endDateStr}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new Error('Rango de fechas inválido para refrescar la ocupación');
  }

  const snapshots = [];
  let cursor = new Date(start);

  while (cursor <= end) {
    const currentDate = toDateString(cursor);
    console.log(`[AimHarder] Refrescando ocupación histórica para ${currentDate}`);
    const snapshot = await refreshAndStoreOccupancy(currentDate, centerId);
    snapshots.push(snapshot);
    cursor = addDays(cursor, 1);
  }

  return snapshots;
}

async function syncActiveClients(dateStr = null, centerId) {
  const reportDate = dateStr || toDateString(new Date());
  const config = await getCenterAimHarderConfig(centerId);
  const clients = await syncActiveClientsViaApi(reportDate, config);
  return { date: reportDate, count: clients.length };
}

function clearSessionCache(centerKey = null) {
  if (centerKey) {
    sessionCacheByCenter.delete(centerKey);
    apiTokenCacheByCenter.delete(centerKey);
    console.log(`[AimHarder] Caché de sesión limpiada para ${centerKey}`);
    return;
  }

  sessionCacheByCenter.clear();
  apiTokenCacheByCenter.clear();
  console.log('[AimHarder] Caché de sesión limpiada');
}

async function getStoredAimHarderIntegration(centerId) {
  const config = await getCenterAimHarderConfig(centerId);
  return {
    centerId: config.centerId,
    centerName: config.centerName,
    key: config.cacheKey,
    baseUrl: config.baseUrl || '',
    username: config.username || '',
    password: config.password || '',
    accessToken: config.accessToken || '',
    refreshToken: config.refreshToken || '',
  };
}

async function upsertAimHarderIntegration(centerId, data = {}) {
  const center = await Center.findById(centerId);
  if (!center) {
    throw new Error('Centro no encontrado para actualizar la integración de AimHarder');
  }

  const key = getCenterFallbackKey(center);
  const current = await AimHarderIntegration.findOne({ center: center._id }).select(
    '+baseUrl +username +password +accessToken +refreshToken +lastTokenRefreshAt'
  );

  const nextValues = {
    key,
    baseUrl: data.baseUrl ?? current?.baseUrl ?? '',
    username: data.username ?? current?.username ?? '',
    password: data.password ?? current?.password ?? '',
    accessToken: data.accessToken ?? current?.accessToken ?? '',
    refreshToken: data.refreshToken ?? current?.refreshToken ?? '',
  };

  const integration = await AimHarderIntegration.findOneAndUpdate(
    { center: center._id },
    { $set: nextValues },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  ).select('+baseUrl +username +password +accessToken +refreshToken +lastTokenRefreshAt');

  const cacheKey = key || String(center._id);
  clearSessionCache(cacheKey);

  return {
    centerId: String(center._id),
    centerName: center.name,
    key: integration.key || cacheKey,
    baseUrl: integration.baseUrl || '',
    username: integration.username || '',
    password: integration.password || '',
    accessToken: integration.accessToken || '',
    refreshToken: integration.refreshToken || '',
  };
}

async function seedAimHarderIntegrationsFromEnv() {
  const centers = await Center.find({ active: true }).select('_id name aimharderKey');

  for (const center of centers) {
    const key = getCenterFallbackKey(center);
    if (!key) continue;

    const prefix = `AIMHARDER_${key}_`;
    const envConfig = {
      key,
      baseUrl: process.env[`${prefix}URL`] || process.env.AIMHARDER_URL || '',
      username: process.env[`${prefix}USERNAME`] || process.env.AIMHARDER_USERNAME || '',
      password: process.env[`${prefix}PASSWORD`] || process.env.AIMHARDER_PASSWORD || '',
      accessToken: process.env[`${prefix}API_ACCESS_TOKEN`] || process.env.AIMHARDER_API_ACCESS_TOKEN || '',
      refreshToken: process.env[`${prefix}API_REFRESH_TOKEN`] || process.env.AIMHARDER_API_REFRESH_TOKEN || '',
    };

    if (!envConfig.baseUrl && !envConfig.username && !envConfig.accessToken && !envConfig.refreshToken) {
      continue;
    }

    const existing = await AimHarderIntegration.findOne({ center: center._id }).select(
      '+baseUrl +username +password +accessToken +refreshToken +lastTokenRefreshAt'
    );

    if (!existing) {
      await AimHarderIntegration.create({
        center: center._id,
        ...envConfig,
      });
      continue;
    }

    const updates = {};
    if (!existing.key && envConfig.key) updates.key = envConfig.key;
    if (!existing.baseUrl && envConfig.baseUrl) updates.baseUrl = envConfig.baseUrl;
    if (!existing.username && envConfig.username) updates.username = envConfig.username;
    if (!existing.password && envConfig.password) updates.password = envConfig.password;
    if (!existing.accessToken && envConfig.accessToken) updates.accessToken = envConfig.accessToken;
    if (!existing.refreshToken && envConfig.refreshToken) updates.refreshToken = envConfig.refreshToken;

    if (Object.keys(updates).length > 0) {
      await AimHarderIntegration.findOneAndUpdate(
        { center: center._id },
        { $set: updates },
        { new: true }
      );
    }
  }
}

// ─────────────────────────────────────────────────────
// Pagos con fallo TPV Redsys
// ─────────────────────────────────────────────────────

const KNOWN_TARIFFS = ['TEMPUS +65', 'CONGELACION', 'CONGELACIÓN', 'TARIFA CONGELACION', 'TARIFA CONGELACIÓN', 'STARTER', 'IRON', 'SILVER', 'GOLD', 'ON RAMP'];

function extractTarifa(concept) {
  const upper = concept.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const NORMALIZED_TARIFFS = KNOWN_TARIFFS.map(t => t.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  for (let i = 0; i < NORMALIZED_TARIFFS.length; i++) {
    if (upper.includes(NORMALIZED_TARIFFS[i])) return KNOWN_TARIFFS[i];
  }
  // Fallback: first sequence of uppercase letters before " -" or digit
  const m = concept.match(/^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s+65]*?)(?:\s+-|\s+\d|\s+\()/);
  return m ? m[1].trim() : concept.split(/[\s-]/)[0];
}

async function getPendingPaymentsWithTPVError(centerId) {
  const config = await getCenterAimHarderConfig(centerId);

  if (!config.username || !config.password) {
    throw new Error(
      `Faltan credenciales de AimHarder para ${config.centerName}. Configura las credenciales en la integración del centro.`
    );
  }

  console.log('[AimHarder] ===== Scraping pagos con fallo TPV =====');
  try {
    const pending = await getPendingPaymentsRaw(config);

    // Keep only payments that have a TPV RedsYs error code (tpverrcode != null)
    const tpvFailures = pending.filter((p) => p.tpverrcode != null);
    console.log(`[AimHarder] ${tpvFailures.length} pagos con fallo TPV encontrados`);

    const payments = tpvFailures.map((p) => ({
      memberName: (p.name || '').replace(/\s+/g, ' ').trim(),
      concept: p.concept || '',
      tarifa: extractTarifa(p.concept || ''),
      amount: p.amount || '',
      date: p.since || '',
      phone: p.movil || '',
    }));

    return payments;
  } finally {
    console.log('[AimHarder] ===== Fin scraping TPV =====');
  }
}

async function getPendingPaymentsRaw(config) {
  const browser = await chromium.launch({ headless: true, slowMo: 0 });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const sessionCache = await getSessionCache(config);
    if (sessionCache.cookies && sessionCache.expiry && Date.now() < sessionCache.expiry) {
      await context.addCookies(sessionCache.cookies);
      console.log('[AimHarder] Sesión restaurada desde caché');
    }

    const page = await context.newPage();
    await ensureAuthenticatedSession(page, config);

    await setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    const paymentsUrl = `${config.baseUrl}/payments`;
    const pendingApiUrl = `${config.baseUrl}/api/pendingPayments`;
    console.log('[AimHarder] Navegando a pagos pendientes:', paymentsUrl);

    const pendingResponsePromise = page.waitForResponse(
      (resp) => resp.url().startsWith(pendingApiUrl),
      { timeout: 45000 }
    );

    await page.goto(paymentsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissCookies(page);

    let pending = [];
    try {
      const pendingResponse = await pendingResponsePromise;
      const raw = await pendingResponse.text();
      const data = JSON.parse(raw);
      pending = data.pending || [];
      console.log(`[AimHarder] /api/pendingPayments devolvió ${pending.length} pagos pendientes`);
    } catch (e) {
      console.warn('[AimHarder] No se pudo capturar /api/pendingPayments:', e.message);
    }

    return pending;
  } finally {
    await browser.close();
  }
}

async function getPendingPaymentsWithoutTPVError(centerId) {
  const config = await getCenterAimHarderConfig(centerId);

  if (!config.username || !config.password) {
    throw new Error(
      `Faltan credenciales de AimHarder para ${config.centerName}. Configura las credenciales en la integración del centro.`
    );
  }

  console.log('[AimHarder] ===== Scraping todos los pagos pendientes =====');
  try {
    const pending = await getPendingPaymentsRaw(config);

    console.log(`[AimHarder] ${pending.length} pagos pendientes encontrados (sin excluir fallos TPV)`);

    return pending.map((p) => ({
      memberName: (p.name || '').replace(/\s+/g, ' ').trim(),
      concept: p.concept || '',
      tarifa: extractTarifa(p.concept || ''),
      amount: p.amount || '',
      date: p.since || '',
      phone: p.movil || '',
      hasTpvError: p.tpverrcode != null && String(p.tpverrcode).trim() !== '',
      tpvErrorCode: p.tpverrcode != null ? String(p.tpverrcode).trim() : '',
    }));
  } finally {
    console.log('[AimHarder] ===== Fin scraping todos los pagos pendientes =====');
  }
}

async function parseTariffCancellationRows(context) {
  return context.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const includesAny = (source, needles) => needles.some((needle) => source.includes(needle));

    const tables = Array.from(document.querySelectorAll('table'));
    let selectedTable = null;
    let selectedHeader = [];

    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('thead th, tr th')).map((th) =>
        normalize(th.textContent).toLowerCase()
      );

      if (!headers.length) continue;

      if (headers.some((h) => h.includes('tarifas canceladas'))) {
        selectedTable = table;
        selectedHeader = headers;
        break;
      }
    }

    if (!selectedTable) {
      // Fallback robusto: detectar filas por contenido, aunque no haya header estándar.
      const fallbackRows = [];
      const seen = new Set();
      const allRows = Array.from(document.querySelectorAll('table tr'));

      for (const row of allRows) {
        const cells = Array.from(row.querySelectorAll('td')).map((td) => normalize(td.textContent));
        if (cells.length < 2) continue;

        let tariffCellIndex = -1;
        for (let i = 0; i < cells.length; i += 1) {
          if (/(semestral|trimestral)/i.test(cells[i])) {
            tariffCellIndex = i;
            break;
          }
        }
        if (tariffCellIndex === -1) continue;

        const nameFromLink = normalize(row.querySelector('a')?.textContent || '');
        const memberName = nameFromLink || normalize(cells[1] || cells[0] || '');
        const phone = normalize(cells.find((c) => /^\d{7,15}(?:[\s,;/.-]\d{7,15})*$/.test(c)) || '');
        const cancelledTariff = normalize(cells[tariffCellIndex] || '');
        const cancellationDate = normalize(cells.find((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c)) || '');

        if (!memberName || !cancelledTariff) continue;

        const dedupeKey = `${memberName}::${phone}::${cancelledTariff}::${cancellationDate}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        fallbackRows.push({
          memberName,
          phone,
          cancelledTariff,
          cancellationDate,
        });
      }

      return fallbackRows;
    }

    const findIdx = (candidates) => selectedHeader.findIndex((header) => includesAny(header, candidates));

    const nameIdx = findIdx(['nombre y apellidos', 'cliente', 'nombre']);
    const phoneIdx = findIdx(['telefonos', 'teléfonos', 'telefono', 'teléfono', 'movil', 'móvil']);
    const tariffIdx = findIdx(['tarifas canceladas', 'tarifa cancelada', 'tarifa']);
    const endDateIdx = findIdx(['fecha de baja', 'baja']);

    const rows = Array.from(selectedTable.querySelectorAll('tbody tr')).length
      ? Array.from(selectedTable.querySelectorAll('tbody tr'))
      : Array.from(selectedTable.querySelectorAll('tr')).slice(1);

    const results = [];
    const seen = new Set();

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map((td) => normalize(td.textContent));
      if (!cells.length) continue;

      const memberName = normalize(nameIdx >= 0 ? cells[nameIdx] : cells[1] || cells[0]);
      const phone = normalize(phoneIdx >= 0 ? cells[phoneIdx] : '');
      const cancelledTariff = normalize(tariffIdx >= 0 ? cells[tariffIdx] : '');
      const cancellationDate = normalize(endDateIdx >= 0 ? cells[endDateIdx] : '');

      if (!memberName || !cancelledTariff) continue;
      if (!/(semestral|trimestral)/i.test(cancelledTariff)) continue;

      const dedupeKey = `${memberName}::${phone}::${cancelledTariff}::${cancellationDate}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      results.push({
        memberName,
        phone,
        cancelledTariff,
        cancellationDate,
      });
    }

    return results;
  });
}

async function parseTariffChangeRows(context) {
  return context.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const includesAny = (source, needles) => needles.some((needle) => source.includes(needle));
    // Extrae el cid interno del cliente (el que abre /clients?cid=NNN) desde el
    // HTML de la fila: parámetro cid=, otros params de usuario, o el id numérico
    // (>=5 dígitos, distinto del nº de socio) en la URL de la foto del cliente.
    const extractCid = (html) => {
      const s = String(html || '');
      const m =
        s.match(/[?&]cid=(\d+)/i) ||
        s.match(/[?&](?:u|uid|user|userid|idcliente|clientid)=(\d{4,})/i) ||
        s.match(/\/(\d{5,})[^/]*\.(?:jpg|jpeg|png|webp|gif)/i);
      return m ? m[1] : '';
    };

    const tables = Array.from(document.querySelectorAll('table'));
    let selectedTable = null;
    let selectedHeader = [];

    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('thead th, tr th')).map((th) =>
        normalize(th.textContent).toLowerCase()
      );

      if (!headers.length) continue;

      if (headers.some((h) => h.includes('nuevas tarifas')) && headers.some((h) => h.includes('tarifas dadas de baja'))) {
        selectedTable = table;
        selectedHeader = headers;
        break;
      }
    }

    if (!selectedTable) {
      // Fallback robusto: detectar filas por contenido, aunque no haya header estándar.
      const fallbackRows = [];
      const seen = new Set();
      const allRows = Array.from(document.querySelectorAll('table tr'));

      for (const row of allRows) {
        const cells = Array.from(row.querySelectorAll('td')).map((td) => normalize(td.textContent));
        if (cells.length < 3) continue;

        const nameFromLink = normalize(row.querySelector('a')?.textContent || '');
        const memberName = nameFromLink || normalize(cells[1] || cells[0] || '');
        const phone = normalize(cells.find((c) => /^\d{7,15}(?:[\s,;/.-]\d{7,15})*$/.test(c)) || '');
        const joinDate = normalize(cells.find((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c)) || '');
        const cid = extractCid(row.innerHTML);
        const profileHref = cid
          ? `clients?cid=${cid}`
          : normalize(row.querySelector('a')?.getAttribute('href') || '');

        if (!memberName) continue;

        const dedupeKey = `${memberName}::${phone}::${joinDate}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        fallbackRows.push({
          memberName,
          phone,
          cancelledTariff: '',
          newTariff: '',
          joinDate,
          profileHref,
        });
      }

      return fallbackRows;
    }

    const findIdx = (candidates) => selectedHeader.findIndex((header) => includesAny(header, candidates));

    const idIdx = findIdx(['id']);
    const nameIdx = findIdx(['nombre y apellidos', 'cliente', 'nombre']);
    const phoneIdx = findIdx(['telefonos', 'teléfonos', 'telefono', 'teléfono', 'movil', 'móvil']);
    const localityIdx = findIdx(['localidad', 'ciudad']);
    const cancelledTariffIdx = findIdx(['tarifas dadas de baja', 'tarifa dada de baja', 'tarifas de baja', 'baja']);
    const newTariffIdx = findIdx(['nuevas tarifas', 'nueva tarifa', 'tarifas nuevas', 'alta tarifa']);
    const joinDateIdx = findIdx(['fecha de alta', 'alta']);

    const rows = Array.from(selectedTable.querySelectorAll('tbody tr')).length
      ? Array.from(selectedTable.querySelectorAll('tbody tr'))
      : Array.from(selectedTable.querySelectorAll('tr')).slice(1);

    const results = [];
    const seen = new Set();

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map((td) => normalize(td.textContent));
      if (!cells.length) continue;

      const id = normalize(idIdx >= 0 ? cells[idIdx] : '');
      const memberName = normalize(nameIdx >= 0 ? cells[nameIdx] : cells[1] || cells[0]);
      const phone = normalize(phoneIdx >= 0 ? cells[phoneIdx] : '');
      const locality = normalize(localityIdx >= 0 ? cells[localityIdx] : '');
      const cancelledTariff = normalize(cancelledTariffIdx >= 0 ? cells[cancelledTariffIdx] : '');
      const newTariff = normalize(newTariffIdx >= 0 ? cells[newTariffIdx] : '');
      const joinDate = normalize(joinDateIdx >= 0 ? cells[joinDateIdx] : '');
      // Enlace al perfil del cliente en AimHarder (se abre con ?cid=NNN, id interno
      // distinto del ID de socio de la tabla).
      const cid = extractCid(row.innerHTML);
      const profileHref = cid
        ? `clients?cid=${cid}`
        : normalize(row.querySelector('a')?.getAttribute('href') || '');

      if (!memberName) continue;

      const dedupeKey = `${id}::${memberName}::${phone}::${cancelledTariff}::${newTariff}::${joinDate}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      results.push({
        id,
        memberName,
        phone,
        locality,
        cancelledTariff,
        newTariff,
        joinDate,
        profileHref,
      });
    }

    return results;
  });
}

async function parseActiveClientsRows(context) {
  return context.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();

    const includesAny = (source, needles) => needles.some((needle) => source.includes(needle));
    const tables = Array.from(document.querySelectorAll('table'));
    let selectedTable = null;
    let selectedHeader = [];

    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('thead th, tr th')).map((th) => lower(th.textContent));
      if (!headers.length) continue;
      const looksLikeActiveClients =
        headers.some((h) => h.includes('tarifas activas')) &&
        headers.some((h) => h.includes('nombre y apellidos'));
      if (looksLikeActiveClients) {
        selectedTable = table;
        selectedHeader = headers;
        break;
      }
    }

    if (!selectedTable) return [];

    const findIdx = (candidates) => selectedHeader.findIndex((header) => includesAny(header, candidates));
    const nameIdx = findIdx(['nombre y apellidos', 'cliente', 'nombre']);
    const phoneIdx = findIdx(['telefonos', 'teléfonos', 'telefono', 'teléfono', 'movil', 'móvil']);
    const localityIdx = findIdx(['localidad', 'ciudad']);
    const tariffIdx = findIdx(['tarifas activas', 'tarifa activa', 'tarifa']);
    const tariffStartIdx = findIdx(['inicio de la tarifa', 'inicio tarifa']);
    const joinDateIdx = findIdx(['fecha de alta', 'alta']);

    const rows = Array.from(selectedTable.querySelectorAll('tbody tr')).length
      ? Array.from(selectedTable.querySelectorAll('tbody tr'))
      : Array.from(selectedTable.querySelectorAll('tr')).slice(1);

    const results = [];
    const seen = new Set();

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map((td) => normalize(td.textContent));
      if (!cells.length) continue;

      const memberName = normalize(nameIdx >= 0 ? cells[nameIdx] : cells[1] || cells[0]);
      const phone = normalize(phoneIdx >= 0 ? cells[phoneIdx] : '');
      const locality = normalize(localityIdx >= 0 ? cells[localityIdx] : '');
      const activeTariff = normalize(tariffIdx >= 0 ? cells[tariffIdx] : '');
      const tariffStartDate = normalize(tariffStartIdx >= 0 ? cells[tariffStartIdx] : '');
      const joinDate = normalize(joinDateIdx >= 0 ? cells[joinDateIdx] : '');

      if (!memberName) continue;

      const dedupeKey = `${memberName}::${phone}::${activeTariff}::${tariffStartDate}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      results.push({
        memberName,
        phone,
        locality,
        activeTariff,
        tariffStartDate,
        joinDate,
      });
    }

    return results;
  });
}

function buildActiveTariffSummary(clients) {
  const summaryMap = new Map();
  for (const client of clients) {
    const tariff = String(client.activeTariff || '').trim() || 'Sin tarifa';
    summaryMap.set(tariff, (summaryMap.get(tariff) || 0) + 1);
  }

  return Array.from(summaryMap.entries())
    .map(([tariff, count]) => ({ tariff, count }))
    .sort((a, b) => b.count - a.count);
}

function normalizeTariffFilterValue(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldExcludeActiveTariff(value = '') {
  const normalized = normalizeTariffFilterValue(value);
  if (!normalized) return false;
  return normalized.includes('coach') || normalized.includes('congelacion');
}

function filterExcludedActiveClients(clients = []) {
  return (Array.isArray(clients) ? clients : []).filter((client) => {
    const tariff = String(client?.activeTariff || '');
    return !shouldExcludeActiveTariff(tariff);
  });
}

function normalizeMonthLabelForCompare(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function getTargetMonthLabelCandidates(monthStr) {
  const [year, month] = String(monthStr || '').split('-').map(Number);
  if (!year || !month) return [];
  const date = new Date(year, month - 1, 1);
  const monthLong = date.toLocaleDateString('es-ES', { month: 'long' });
  const monthShort = date.toLocaleDateString('es-ES', { month: 'short' });
  const yearStr = String(year);
  return [
    `${monthLong} ${yearStr}`,
    `${monthShort} ${yearStr}`,
    `${monthLong}${yearStr}`,
    `${monthShort}${yearStr}`,
    `${monthStr}`,
  ].map(normalizeMonthLabelForCompare);
}

function metricsDebugLog(...args) {
  if (!METRICS_DEBUG) return;
  console.log('[AimHarder Metrics DEBUG]', ...args);
}

function parseNumericValueFromText(value = '') {
  const match = String(value || '').match(/-?\d+(?:[\.,]\d+)?/);
  if (!match) return null;
  const normalized = match[0].replace(',', '.');
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? number : null;
}

function tryExtractDashboardMetricsFromPayload(payload, monthStr) {
  const candidates = getTargetMonthLabelCandidates(monthStr);
  if (!candidates.length) return null;

  const visit = (node) => {
    if (!node || typeof node !== 'object') return null;

    if (Array.isArray(node.categories) && Array.isArray(node.series)) {
      const categories = node.categories.map((item) => normalizeMonthLabelForCompare(item));
      const idx = categories.findIndex((label) => candidates.some((candidate) => label.includes(candidate) || candidate.includes(label)));
      if (idx >= 0) {
        let altas = null;
        let bajas = null;
        for (const serie of node.series) {
          const name = normalizeMonthLabelForCompare(serie?.name || '');
          const value = Array.isArray(serie?.data) ? parseNumericValueFromText(serie.data[idx]) : null;
          if (value == null) continue;
          if (name.includes('alta') || name.includes('signup') || name.includes('new')) altas = value;
          if (name.includes('baja') || name.includes('drop') || name.includes('cancel')) bajas = value;
        }
        if (altas != null || bajas != null) {
          return {
            newSignups: altas == null ? 0 : Math.max(0, Math.round(altas)),
            monthlyCancellations: bajas == null ? 0 : Math.max(0, Math.round(bajas)),
          };
        }
      }
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        if (!item || typeof item !== 'object') continue;
        const monthLabel = normalizeMonthLabelForCompare(item.month || item.mes || item.label || item.name || item.x || item.date || '');
        if (!monthLabel) continue;
        const matches = candidates.some((candidate) => monthLabel.includes(candidate) || candidate.includes(monthLabel));
        if (!matches) continue;
        const altas = parseNumericValueFromText(item.altas ?? item.alta ?? item.signups ?? item.newSignups ?? item.new ?? item.y);
        const bajas = parseNumericValueFromText(item.bajas ?? item.baja ?? item.cancellations ?? item.dropouts ?? item.drops);
        if (altas != null || bajas != null) {
          return {
            newSignups: altas == null ? 0 : Math.max(0, Math.round(altas)),
            monthlyCancellations: bajas == null ? 0 : Math.max(0, Math.round(bajas)),
          };
        }
      }
    }

    for (const value of Object.values(node)) {
      const found = visit(value);
      if (found) return found;
    }
    return null;
  };

  return visit(payload);
}

async function tryExtractMetricFromChartJsData(chartContainer, monthStr) {
  const candidates = getTargetMonthLabelCandidates(monthStr);
  if (!candidates.length) return null;

  // Try to extract from page level, not just container
  const chartValue = await chartContainer.page().evaluate((normalizedCandidates, monthStr) => {
    const normalize = (value) =>
      String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

    const parseNumber = (value) => {
      const match = String(value ?? '').match(/-?\d+(?:[\.,]\d+)?/);
      if (!match) return null;
      const parsed = Number.parseFloat(match[0].replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : null;
    };

    if (!window.Chart) return null;

    window.__METRICS_DEBUG = window.__METRICS_DEBUG || {};

    const instances = window.Chart.instances;
    if (!instances) {
      window.__METRICS_DEBUG.instancesFound = 0;
      return null;
    }

    const instanceArray = Array.isArray(instances) ? instances : Object.values(instances);
    window.__METRICS_DEBUG.instancesScanned = instanceArray.length;
    window.__METRICS_DEBUG.allInstanceLabels = [];
    window.__METRICS_DEBUG.instancesWithData = [];

    // Scan all instances looking for one with matching month labels
    for (let i = 0; i < instanceArray.length; i++) {
      const instance = instanceArray[i];
      if (!instance || !instance.data || !instance.data.labels) continue;

      const labels = Array.isArray(instance.data.labels) ? instance.data.labels : [];
      window.__METRICS_DEBUG.allInstanceLabels.push({
        index: i,
        labels: labels.slice(0, 15),
        normalized: labels.slice(0, 15).map(normalize),
      });

      const normalizedLabels = labels.map((label) => normalize(String(label || '')));

      // Check if this instance has labels matching our month
      const targetIndex = normalizedLabels.findIndex((label) =>
        normalizedCandidates.some((candidate) => label.includes(candidate) || candidate.includes(label))
      );

      if (targetIndex < 0) continue; // No match, skip this instance

      window.__METRICS_DEBUG.instancesWithData.push({
        index: i,
        labelCount: labels.length,
        targetLabel: labels[targetIndex],
        datasetCount: (instance.data.datasets || []).length,
      });

      // Try to extract value from this instance
      const datasets = Array.isArray(instance.data.datasets) ? instance.data.datasets : [];
      for (let d = 0; d < datasets.length; d++) {
        const dataset = datasets[d];
        if (!dataset || !Array.isArray(dataset.data)) continue;

        const rawValue = dataset.data[targetIndex];
        const numeric = parseNumber(rawValue);

        if (numeric != null) {
          window.__METRICS_DEBUG.extractedFrom = {
            instanceIndex: i,
            datasetIndex: d,
            rawValue,
            numeric,
          };
          return Math.max(0, Math.round(numeric));
        }
      }
    }

    return null;
  }, candidates, monthStr).catch((err) => {
    metricsDebugLog('chartjs page-level evaluate error', err.message);
    return null;
  });

  // Retrieve debug info
  if (chartValue === null) {
    const debugInfo = await chartContainer.page().evaluate(() => window.__METRICS_DEBUG).catch(() => null);
    if (debugInfo) {
      metricsDebugLog('chartjs page-level debug', debugInfo);
    }
  }

  return chartValue;
}

async function tryExtractMetricFromChartHover(page, chartTitleRegex, monthStr) {
  const candidates = getTargetMonthLabelCandidates(monthStr);
  if (!candidates.length) return null;

  metricsDebugLog('hover candidates', { chart: String(chartTitleRegex), monthStr, candidates });

  const heading = page.getByText(chartTitleRegex).first();
  const headingCount = await heading.count();
  metricsDebugLog('hover heading count', { chart: String(chartTitleRegex), headingCount });
  if (!headingCount) return null;

  const chartContainer = heading.locator('xpath=ancestor::div[1]');
  const points = chartContainer.locator('svg .highcharts-point, svg circle, svg [class*="point"]');
  const count = await points.count();
  metricsDebugLog('hover points found', { chart: String(chartTitleRegex), points: count });
  if (!count) {
    const containerDiagnostics = await chartContainer.evaluate((el) => {
      const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      const chartJs = window.Chart;
      const chartJsInfo = {
        hasChartJs: !!chartJs,
        version: chartJs?.version || null,
        instanceCount:
          (chartJs?.instances && Object.keys(chartJs.instances || {}).length) ||
          (Array.isArray(chartJs?.instances) ? chartJs.instances.length : 0) ||
          0,
      };

      return {
        tag: el.tagName,
        className: el.className,
        hasCanvas: el.querySelectorAll('canvas').length,
        hasSvg: el.querySelectorAll('svg').length,
        highchartsPoints: el.querySelectorAll('.highcharts-point').length,
        apexPoints: el.querySelectorAll('.apexcharts-series path, .apexcharts-marker').length,
        textPreview: text.slice(0, 180),
        chartJsInfo,
      };
    }).catch(() => null);
    metricsDebugLog('hover container diagnostics', { chart: String(chartTitleRegex), containerDiagnostics });

    const chartJsValue = await tryExtractMetricFromChartJsData(chartContainer, monthStr);
    metricsDebugLog('chartjs direct extraction', { chart: String(chartTitleRegex), chartJsValue });
    return chartJsValue;
  }

  const max = Math.min(count, 24);
  for (let i = 0; i < max; i += 1) {
    try {
      await points.nth(i).hover({ timeout: 1500 });
      await page.waitForTimeout(120).catch(() => {});

      const tooltipText = await page.evaluate(() => {
        const selectors = [
          '.highcharts-tooltip text',
          '.highcharts-tooltip',
          '.apexcharts-tooltip',
          '[class*="tooltip"]',
        ];

        const lines = [];
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector));
          for (const node of nodes) {
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
            const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
            if (text) lines.push(text);
          }
        }
        return lines.join(' ');
      });

      const normalized = normalizeMonthLabelForCompare(tooltipText);
      const matches = candidates.some((candidate) => normalized.includes(candidate) || candidate.includes(normalized));
      metricsDebugLog('hover tooltip scan', {
        chart: String(chartTitleRegex),
        point: i,
        tooltip: tooltipText.slice(0, 140),
        normalized: normalized.slice(0, 140),
        matches,
      });
      if (!matches) continue;

      const value = parseNumericValueFromText(tooltipText);
      if (value != null) return Math.max(0, Math.round(value));
    } catch {
      // Continue with the next point
    }
  }

  return null;
}

async function getActiveClientsMonthlyReport(centerId, monthStr = null) {
  const config = await getCenterAimHarderConfig(centerId);

  if (!config.username || !config.password) {
    throw new Error(
      `Faltan credenciales de AimHarder para ${config.centerName}. Configura las credenciales en la integración del centro.`
    );
  }

  const range = getMonthlyDateRange(monthStr);
  console.log('[AimHarder] ===== Scraping clientes activos =====');
  console.log(`[AimHarder] Mes seleccionado: ${range.month} (${range.startIso} -> ${range.endIso})`);

  const browser = await chromium.launch({ headless: true, slowMo: 0 });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const sessionCache = await getSessionCache(config);
    if (sessionCache.cookies && sessionCache.expiry && Date.now() < sessionCache.expiry) {
      await context.addCookies(sessionCache.cookies);
      console.log('[AimHarder] Sesión restaurada desde caché');
    }

    const page = await context.newPage();
    const reportsUrl = `${config.baseUrl}/reports`;

    await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    if (!isAuthenticatedAimHarderUrl(page.url())) {
      await login(page, config);
      await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await dismissCookies(page);
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    }

    await setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    // Cerrar avisos promocionales que tapan botones (rediseño del menú, etc.).
    await dismissAimHarderPromos(page);

    const activeClientsCard = page
      .locator('a, button')
      .filter({ hasText: /clientes activos/i })
      .first();

    if (!(await activeClientsCard.count())) {
      throw new Error('No se encontró la tarjeta de "Clientes activos" en Informes');
    }

    const activeClientsMeta = await activeClientsCard.evaluate((el) => ({
      onclick: el.getAttribute('onclick'),
      text: (el.textContent || '').trim(),
    })).catch(() => null);
    console.log('[AimHarder] Meta Clientes activos:', activeClientsMeta);

    let clicked = false;
    try {
      await activeClientsCard.click({ force: true, timeout: 8000 });
      clicked = true;
    } catch {
      clicked = false;
    }

    if (!clicked && activeClientsMeta?.onclick) {
      await page.evaluate((onclickCode) => {
        try {
          // eslint-disable-next-line no-eval
          eval(onclickCode);
        } catch {
          // ignore fallback failures
        }
      }, activeClientsMeta.onclick).catch(() => {});
    }

    await page.waitForTimeout(700).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await dismissAimHarderPromos(page);

    const formSetupDebug = await page.evaluate(({ startInput, endInput }) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const parseEsDate = (value) => {
        const match = String(value || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!match) return null;
        const day = Number(match[1]);
        const month = Number(match[2]);
        const year = Number(match[3]);
        const date = new Date(year, month - 1, day);
        return Number.isNaN(date.getTime()) ? null : date;
      };

      const getFormScope = () => {
        const containers = Array.from(document.querySelectorAll('form, fieldset, .box, .panel, .card, section, div'));
        return containers.find((container) => {
          const text = normalize(container.textContent);
          return text.includes('clientes activos') && text.includes('fechas') && text.includes('generar informe');
        }) || null;
      };

      const getDateInputsFromFechasPanel = () => {
        const candidate = getFormScope();
        if (!candidate) return [];
        return Array.from(candidate.querySelectorAll('input[type="text"], input[type="date"]')).filter((input) => {
          const style = window.getComputedStyle(input);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
      };

      const setDateInput = (input, value) => {
        if (!input) return;
        try {
          if (window.jQuery && window.jQuery.fn && typeof window.jQuery(input).datepicker === 'function') {
            const parsed = parseEsDate(value);
            window.jQuery(input).datepicker('setDate', parsed || value);
          }
        } catch {
          // fallback manual below
        }
        input.focus();
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
      };

      const dateInputs = getDateInputsFromFechasPanel();
      const fromInput = dateInputs[0] || null;
      const toInput = dateInputs[1] || null;

      if (fromInput && toInput) {
        setDateInput(fromInput, startInput);
        setDateInput(toInput, endInput);
      }

      // Ajuste requerido: en "Estado cuenta" forzar "Cuenta no bloqueada"
      // y en "Excluir clientes con el pago de su mensualidad cancelado" forzar "Sí".
      const selects = Array.from(document.querySelectorAll('select'));
      for (const select of selects) {
        const contextText = normalize(
          (select.closest('label') && select.closest('label').textContent) ||
          (select.parentElement && select.parentElement.textContent) ||
          ''
        );

        if (contextText.includes('estado cuenta')) {
          const option = Array.from(select.options).find((opt) =>
            normalize(opt.textContent).includes('cuenta no bloqueada')
          );
          if (option) {
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          continue;
        }

        if (contextText.includes('excluir clientes con el pago de su mensualidad cancelado')) {
          const option = Array.from(select.options).find((opt) =>
            normalize(opt.textContent) === 'sí' || normalize(opt.textContent) === 'si'
          );
          if (option) {
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }

      // Selección robusta del filtro de tarifa objetivo en el select principal de AimHarder.
      const targetTariffSelect = document.querySelector('#flTarifaMultiple');
      let targetTariffApplied = false;
      let targetTariffText = '';

      if (targetTariffSelect && targetTariffSelect.tagName === 'SELECT') {
        const option = Array.from(targetTariffSelect.options).find((opt) =>
          normalize(opt.textContent).includes('tarifas de tipo mensual o semanal')
        );

        if (option) {
          targetTariffText = String(option.textContent || '').trim();

          if (targetTariffSelect.multiple) {
            for (const opt of Array.from(targetTariffSelect.options)) {
              opt.selected = opt.value === option.value;
            }
          } else {
            targetTariffSelect.value = option.value;
          }

          targetTariffSelect.dispatchEvent(new Event('input', { bubbles: true }));
          targetTariffSelect.dispatchEvent(new Event('change', { bubbles: true }));

          if (window.jQuery) {
            try {
              const $select = window.jQuery(targetTariffSelect);
              if (targetTariffSelect.multiple) {
                $select.val([option.value]).trigger('change');
              } else {
                $select.val(option.value).trigger('change');
              }
            } catch {
              // ignorar errores jQuery/select2
            }
          }

          const selectedTexts = Array.from(targetTariffSelect.selectedOptions || [])
            .map((opt) => normalize(opt.textContent))
            .filter(Boolean);
          targetTariffApplied = selectedTexts.some((text) => text.includes('tarifas de tipo mensual o semanal'));
        }
      }

      return {
        targetTariffApplied,
        targetTariffText,
      };
    }, { startInput: range.startInput, endInput: range.endInput });

    console.log('[AimHarder] Setup filtros clientes activos:', formSetupDebug);

    // Fallback dirigido al widget select2 real de tarifa.
    if (!formSetupDebug?.targetTariffApplied) {
      try {
        const tariffSelect2Trigger = page.locator('#s2id_flTarifaMultiple, [aria-labelledby="select2-chosen-2"], [id*="s2id_flTarifaMultiple"]').first();
        if (await tariffSelect2Trigger.count()) {
          await tariffSelect2Trigger.click({ timeout: 4000 }).catch(() => {});
          await page.waitForTimeout(300).catch(() => {});
          const option = page.locator('.select2-results li, .select2-result-label').filter({
            hasText: /tarifas de tipo mensual o semanal/i,
          }).first();
          if (await option.count()) {
            await option.click({ timeout: 4000 }).catch(() => {});
            await page.waitForTimeout(300).catch(() => {});
            console.log('[AimHarder] Filtro tarifa aplicado via fallback select2 específico');
          }
        }
      } catch (err) {
        console.warn('[AimHarder] Error en fallback de tarifa:', err.message);
      }
    }

    const tariffFilterVerified = await page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const select = document.querySelector('#flTarifaMultiple');
      if (select && select.tagName === 'SELECT') {
        const selectedTexts = Array.from(select.selectedOptions || []).map((opt) => normalize(opt.textContent));
        return selectedTexts.some((text) => text.includes('tarifas de tipo mensual o semanal'));
      }
      const select2Text = document.querySelector('#s2id_flTarifaMultiple')?.textContent || '';
      return normalize(select2Text).includes('tarifas de tipo mensual o semanal');
    }).catch(() => false);

    if (!tariffFilterVerified) {
      throw new Error('No se pudo aplicar/verificar el filtro de Tarifa "Tarifas de tipo mensual o semanal"');
    }
    console.log('[AimHarder] Filtro tarifa verificado correctamente');

    // Cerrar de nuevo cualquier aviso flotante que pudiera tapar el botón.
    await dismissAimHarderPromos(page);
    const generateButton = page.locator('button, input[type="button"], input[type="submit"], a').filter({ hasText: /generar informe/i }).first();
    if (await generateButton.count()) {
      await generateButton.click({ force: true, timeout: 12000 }).catch(async () => {
        await page.evaluate(() => {
          if (typeof window.generateReport === 'function') {
            window.generateReport();
          }
        }).catch(() => {});
      });
    } else {
      await page.evaluate(() => {
        if (typeof window.generateReport === 'function') {
          window.generateReport();
        }
      }).catch(() => {});
    }

    await page.waitForTimeout(1200).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    await page.waitForFunction(() => {
      const headers = Array.from(document.querySelectorAll('table th')).map((th) =>
        String(th.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim()
      );
      const hasTable = headers.some((h) => h.includes('tarifas activas'));
      if (hasTable) return true;
      const text = String(document.body?.textContent || '').toLowerCase();
      return text.includes('no hay resultados') || text.includes('0 resultados');
    }, { timeout: 25000 }).catch(() => {});

    let clients = await parseActiveClientsRows(page);
    if (!clients.length) {
      const frames = page.frames().filter((frame) => frame !== page.mainFrame());
      for (const frame of frames) {
        try {
          const frameClients = await parseActiveClientsRows(frame);
          if (frameClients.length) {
            clients = frameClients;
            break;
          }
        } catch {
          // ignore inaccessible frames
        }
      }
    }

    const excludedClients = clients.filter((client) => shouldExcludeActiveTariff(client.activeTariff));
    const filteredClients = filterExcludedActiveClients(clients);
    const tariffSummary = buildActiveTariffSummary(filteredClients);
    if (excludedClients.length > 0) {
      console.log(
        `[AimHarder] Excluidos ${excludedClients.length} clientes por tarifa con "coach" o "congelacion"`
      );
    }
    console.log(`[AimHarder] Clientes activos detectados (tras exclusiones): ${filteredClients.length}`);

    return {
      month: range.month,
      startDate: range.startIso,
      endDate: range.endIso,
      clients: filteredClients,
      tariffSummary,
    };
  } finally {
    await browser.close();
    console.log('[AimHarder] ===== Fin scraping clientes activos =====');
  }
}

async function getDashboardMonthlySignupsAndCancellations(config, monthStr) {
  const browser = await chromium.launch({ headless: true, slowMo: 0 });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const sessionCache = await getSessionCache(config);
    if (sessionCache.cookies && sessionCache.expiry && Date.now() < sessionCache.expiry) {
      await context.addCookies(sessionCache.cookies);
    }

    const page = await context.newPage();
    const jsonPayloads = [];
    const jsonPayloadMeta = [];
    page.on('response', async (response) => {
      try {
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('application/json')) return;
        const body = await response.json();
        jsonPayloads.push(body);
        jsonPayloadMeta.push({
          url: response.url(),
          contentType,
          keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 10) : [],
        });
      } catch {
        // ignore response parsing failures
      }
    });

    const controlUrl = `${config.baseUrl}/control`;
    await page.goto(controlUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    metricsDebugLog('control initial url', page.url());

    if (!isAuthenticatedAimHarderUrl(page.url())) {
      await login(page, config);
      await page.goto(controlUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await dismissCookies(page);
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    }

    metricsDebugLog('control authenticated url', page.url());
    metricsDebugLog('json payloads captured', jsonPayloadMeta.map((item) => ({
      url: item.url,
      contentType: item.contentType,
      keys: item.keys,
    })));

    await setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    for (const payload of jsonPayloads) {
      const found = tryExtractDashboardMetricsFromPayload(payload, monthStr);
      if (found) {
        metricsDebugLog('json payload matched month metrics', found);
        return found;
      }
    }

    metricsDebugLog('no JSON payload matched month', monthStr);

    const altas = await tryExtractMetricFromChartHover(page, /^ALTAS$/i, monthStr);
    const bajas = await tryExtractMetricFromChartHover(page, /^BAJAS$/i, monthStr);
    metricsDebugLog('hover extraction result', { altas, bajas, monthStr });

    if (altas == null && bajas == null) {
      throw new Error('No se pudieron extraer ALTAS/BAJAS del panel de control de AimHarder');
    }

    return {
      newSignups: altas == null ? 0 : altas,
      monthlyCancellations: bajas == null ? 0 : bajas,
    };
  } finally {
    await browser.close();
  }
}

async function getStoredClientMonthlySnapshot(centerId, month) {
  return AimHarderClientMonthlySnapshot.findOne({ center: centerId, month }).lean();
}

async function upsertClientMonthlySnapshot(centerId, month, data) {
  return AimHarderClientMonthlySnapshot.findOneAndUpdate(
    { center: centerId, month },
    {
      $set: {
        center: centerId,
        month,
        startDate: data.startDate,
        endDate: data.endDate,
        activeClientsCount: data.activeClientsCount,
        activeClients: data.activeClients,
        activeTariffSummary: data.activeTariffSummary,
        newSignups: data.newSignups,
        monthlyCancellations: data.monthlyCancellations,
        loadedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  ).lean();
}

async function setClientMonthlyMetricsManual(centerId, month, newSignupsManual, monthlyCancellationsManual) {
  const updateData = {};
  
  if (newSignupsManual !== undefined && newSignupsManual !== null) {
    updateData.newSignupsManual = Number(newSignupsManual);
  }
  
  if (monthlyCancellationsManual !== undefined && monthlyCancellationsManual !== null) {
    updateData.monthlyCancellationsManual = Number(monthlyCancellationsManual);
  }

  if (Object.keys(updateData).length === 0) {
    throw new Error('Se debe proporcionar al menos newSignupsManual o monthlyCancellationsManual');
  }

  const result = await AimHarderClientMonthlySnapshot.findOneAndUpdate(
    { center: centerId, month },
    { $set: updateData },
    { upsert: false, new: true }
  ).lean();

  if (!result) {
    throw new Error('No se encontró el reporte mensual para este centro y mes. Carga los datos primero.');
  }

  return result;
}

async function resetClientMonthlySnapshot(centerId, month) {
  const deleted = await AimHarderClientMonthlySnapshot.findOneAndDelete({
    center: centerId,
    month,
  }).lean();

  return {
    deleted: !!deleted,
    month,
  };
}

async function getClientMonthlyReport(centerId, monthStr = null, options = {}) {
  const { refresh = false, cachedOnly = false } = options;
  const range = getMonthlyDateRange(monthStr);

  const stored = await getStoredClientMonthlySnapshot(centerId, range.month);
  if (stored && !refresh) {
    const storedClients = filterExcludedActiveClients(stored.activeClients || []);
    return {
      month: stored.month,
      startDate: stored.startDate,
      endDate: stored.endDate,
      count: storedClients.length,
      clients: storedClients,
      tariffSummary: buildActiveTariffSummary(storedClients),
      newSignups: stored.newSignupsManual !== null ? stored.newSignupsManual : (stored.newSignups || 0),
      monthlyCancellations: stored.monthlyCancellationsManual !== null ? stored.monthlyCancellationsManual : (stored.monthlyCancellations || 0),
      newSignupsManual: stored.newSignupsManual,
      monthlyCancellationsManual: stored.monthlyCancellationsManual,
      loadedAt: stored.loadedAt || null,
      fromCache: true,
      hasData: true,
    };
  }

  if (cachedOnly) {
    return {
      month: range.month,
      startDate: range.startIso,
      endDate: range.endIso,
      count: 0,
      clients: [],
      tariffSummary: [],
      newSignups: 0,
      monthlyCancellations: 0,
      newSignupsManual: null,
      monthlyCancellationsManual: null,
      loadedAt: null,
      fromCache: false,
      hasData: false,
    };
  }

  const config = await getCenterAimHarderConfig(centerId);
  const activeReport = await getActiveClientsMonthlyReport(centerId, range.month);
  let dashboardMetrics = { newSignups: 0, monthlyCancellations: 0 };
  try {
    dashboardMetrics = await getDashboardMonthlySignupsAndCancellations(config, range.month);
  } catch (error) {
    console.warn(
      `[AimHarder] No se pudieron extraer ALTAS/BAJAS para ${range.month} en ${config.centerName}: ${error.message}`
    );
  }

  const saved = await upsertClientMonthlySnapshot(centerId, range.month, {
    startDate: activeReport.startDate,
    endDate: activeReport.endDate,
    activeClientsCount: activeReport.clients.length,
    activeClients: activeReport.clients,
    activeTariffSummary: buildActiveTariffSummary(activeReport.clients),
    newSignups: dashboardMetrics.newSignups,
    monthlyCancellations: dashboardMetrics.monthlyCancellations,
  });

  return {
    month: saved.month,
    startDate: saved.startDate,
    endDate: saved.endDate,
    count: saved.activeClientsCount || 0,
    clients: saved.activeClients || [],
    tariffSummary: saved.activeTariffSummary || [],
    newSignups: saved.newSignupsManual !== null ? saved.newSignupsManual : (saved.newSignups || 0),
    monthlyCancellations: saved.monthlyCancellationsManual !== null ? saved.monthlyCancellationsManual : (saved.monthlyCancellations || 0),
    newSignupsManual: saved.newSignupsManual,
    monthlyCancellationsManual: saved.monthlyCancellationsManual,
    loadedAt: saved.loadedAt || null,
    fromCache: false,
    hasData: true,
  };
}

async function getTariffCancellationRenewals(centerId, referenceDateStr = null, options = {}) {
  const config = await getCenterAimHarderConfig(centerId);

  if (!config.username || !config.password) {
    throw new Error(
      `Faltan credenciales de AimHarder para ${config.centerName}. Configura las credenciales en la integración del centro.`
    );
  }

  // Modo debug: captura pantallazos (base64) y un volcado de todas las tablas
  // que se ven en AimHarder, para diagnosticar cambios en su interfaz.
  const debug = Boolean(options.debug);
  const debugSteps = [];
  let debugTables = [];

  const range = getTermRenewalReportRange(referenceDateStr);
  console.log('[AimHarder] ===== Scraping cancelaciones de tarifa (trimestral/semestral) =====');
  console.log(`[AimHarder] Rango informe: ${range.startIso} -> ${range.endIso}`);

  const browser = await chromium.launch({ headless: true, slowMo: 0 });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const sessionCache = await getSessionCache(config);
    if (sessionCache.cookies && sessionCache.expiry && Date.now() < sessionCache.expiry) {
      await context.addCookies(sessionCache.cookies);
      console.log('[AimHarder] Sesión restaurada desde caché');
    }

    const page = await context.newPage();
    const reportsUrl = `${config.baseUrl}/reports`;

    // Captura un pantallazo (base64) del estado actual para el modo debug.
    const snap = async (label) => {
      if (!debug) return;
      try {
        const buffer = await page.screenshot({ fullPage: true });
        debugSteps.push({
          label,
          url: page.url(),
          image: `data:image/png;base64,${buffer.toString('base64')}`,
        });
      } catch (e) {
        debugSteps.push({ label, url: page.url(), error: e.message });
      }
    };

    // Esta tarea debe entrar directamente a Informes (no pasar por /control).
    console.log('[AimHarder] Navegando directamente a Informes...');
    await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    const initialReportsUrl = page.url();
    if (!isAuthenticatedAimHarderUrl(initialReportsUrl)) {
      console.log('[AimHarder] Sesión no válida en /reports, iniciando login...');
      await login(page, config);
      await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await dismissCookies(page);
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    }

    await setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    // Cerrar avisos promocionales que tapan botones (p. ej. rediseño del menú).
    await dismissAimHarderPromos(page);
    await snap('01-informes');

    // Paso 1: abrir explícitamente "Cancelaciones de tarifa" desde Informes.
    const cancelacionesCard = page
      .locator('a, button')
      .filter({ hasText: /cancelaciones de tarifa/i })
      .first();

    const cardCount = await cancelacionesCard.count();
    console.log(`[AimHarder] Card "Cancelaciones de tarifa" detectada: ${cardCount > 0}`);

    if (!cardCount) {
      throw new Error('No se encontró la tarjeta de "Cancelaciones de tarifa" en Informes');
    }

    const verMeta = await cancelacionesCard.evaluate((el) => ({
      tag: el.tagName,
      text: (el.textContent || '').trim(),
      id: el.id || null,
      className: el.className || null,
      href: el.getAttribute('href'),
      onclick: el.getAttribute('onclick'),
    })).catch(() => null);
    console.log('[AimHarder] Meta Cancelaciones enlace:', verMeta);

    let clicked = false;
    try {
      await cancelacionesCard.click({ force: true, timeout: 8000 });
      clicked = true;
    } catch {
      clicked = false;
    }

    if (!clicked && verMeta?.onclick) {
      const invoked = await page.evaluate((onclickCode) => {
        try {
          // eslint-disable-next-line no-eval
          eval(onclickCode);
          return true;
        } catch {
          return false;
        }
      }, verMeta.onclick);
      console.log('[AimHarder] onclick Cancelaciones ejecutado:', invoked);
    }

    await page.waitForTimeout(700).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    await page.waitForFunction(() => {
      const text = String(document.body?.textContent || '').toLowerCase();
      return text.includes('informes') && text.includes('cancelaciones de tarifa') && text.includes('generar informe');
    }, { timeout: 20000 }).catch(() => {});

    const screenDiagnostics = await page.evaluate(() => {
      const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const lower = (v) => norm(v).toLowerCase();
      const bodyText = lower(document.body?.textContent || '');
      const breadcrumbRaw = Array.from(document.querySelectorAll('h1,h2,h3,h4,.breadcrumb,nav,div,span'))
        .map((el) => norm(el.textContent))
        .find((text) => lower(text).includes('informes') && lower(text).includes('cancelaciones de tarifa')) || '';
      const hasCancelPanel = bodyText.includes('descartar bonos') && bodyText.includes('grupo de tarifas');
      const breadcrumb = breadcrumbRaw.length > 220 ? `${breadcrumbRaw.slice(0, 220)}...` : breadcrumbRaw;
      return {
        url: window.location.href,
        breadcrumb,
        hasGenerateReportFn: typeof window.generateReport === 'function',
        hasCancelPanel,
      };
    });
    console.log('[AimHarder] Diagnostico pantalla:', screenDiagnostics);
    await dismissAimHarderPromos(page);
    await snap('02-cancelaciones-abierto');

    const evaluateResult = await page.evaluate(({ startInput, endInput }) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const parseEsDate = (value) => {
        const match = String(value || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!match) return null;
        const day = Number(match[1]);
        const month = Number(match[2]);
        const year = Number(match[3]);
        const date = new Date(year, month - 1, day);
        return Number.isNaN(date.getTime()) ? null : date;
      };

      const getFormScope = () => {
        const containers = Array.from(document.querySelectorAll('form, fieldset, .box, .panel, .card, section, div'));
        return containers.find((container) => {
          const text = normalize(container.textContent);
          return (
            text.includes('cancelaciones de tarifa') &&
            text.includes('fechas') &&
            text.includes('desde') &&
            text.includes('hasta') &&
            text.includes('generar informe')
          );
        }) || null;
      };

      const getDateInputsFromFechasPanel = () => {
        const candidate = getFormScope();

        if (!candidate) return [];

        return Array.from(candidate.querySelectorAll('input[type="text"], input[type="date"]'))
          .filter((input) => {
            const style = window.getComputedStyle(input);
            return style.display !== 'none' && style.visibility !== 'hidden';
          });
      };

      const setDateInput = (input, value) => {
        if (!input) return;

        try {
          if (window.jQuery && window.jQuery.fn && typeof window.jQuery(input).datepicker === 'function') {
            const parsed = parseEsDate(value);
            window.jQuery(input).datepicker('setDate', parsed || value);
          }
        } catch {
          // fallback manual below
        }

        input.focus();
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
      };

      const dateInputsInDatePanel = getDateInputsFromFechasPanel();
      const fromInput = dateInputsInDatePanel[0] || null;
      const toInput = dateInputsInDatePanel[1] || null;

      if (fromInput && toInput) {
        setDateInput(fromInput, startInput);
        setDateInput(toInput, endInput);
      }

      const selects = Array.from(document.querySelectorAll('select'));
      for (const select of selects) {
        const labelText = normalize(
          (select.closest('label') && select.closest('label').textContent) ||
          (select.parentElement && select.parentElement.textContent) ||
          ''
        );
        const shouldSetNo = labelText.includes('descartar bonos') || labelText.includes('listar clientes');
        if (!shouldSetNo) continue;

        const noOption = Array.from(select.options).find((option) => normalize(option.textContent) === 'no');
        if (noOption) {
          select.value = noOption.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      const scope = getFormScope() || document;
      const triggerCandidates = Array.from(scope.querySelectorAll('button, input[type="button"], input[type="submit"], a'))
        .filter((el) => normalize(el.textContent || el.getAttribute('value')).includes('generar informe'));

      return {
        sameInputResolved: fromInput && toInput ? fromInput === toInput : false,
        scopeFound: !!scope,
        panelInputCount: dateInputsInDatePanel.length,
        fromFound: !!fromInput,
        toFound: !!toInput,
        fromValue: fromInput ? String(fromInput.value || '') : '',
        toValue: toInput ? String(toInput.value || '') : '',
        triggerFound: triggerCandidates.length > 0,
        triggerCount: triggerCandidates.length,
      };
    }, { startInput: range.startInput, endInput: range.endInput });

    console.log('[AimHarder] Resultado evaluate fechas:', {
      ...evaluateResult,
    });

    const dateDiagnostics = await page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const labels = Array.from(document.querySelectorAll('label, span, div, td, strong'));
      const fromLabel = labels.find((el) => normalize(el.textContent) === 'desde');
      const toLabel = labels.find((el) => normalize(el.textContent) === 'hasta');
      return {
        hasFromLabel: !!fromLabel,
        hasToLabel: !!toLabel,
      };
    });
    console.log('[AimHarder] Diagnostico fechas:', dateDiagnostics);

    // Paso 4: click real en el botón visible "Generar informe".
    // Cerrar de nuevo cualquier aviso flotante que pudiera tapar el botón.
    await dismissAimHarderPromos(page);
    const generateCandidates = page.locator('button, input[type="button"], input[type="submit"], a').filter({ hasText: /generar informe/i });
    const generateCount = await generateCandidates.count();
    console.log('[AimHarder] Botones generar informe visibles:', generateCount);
    let generated = false;
    if (generateCount > 0) {
      try {
        await generateCandidates.first().click({ force: true, timeout: 12000 });
        generated = true;
      } catch {
        generated = false;
      }
    }

    if (!generated) {
      const invoked = await page.evaluate(() => {
        try {
          if (typeof window.generateReport === 'function') {
            window.generateReport();
            return 'window.generateReport';
          }

          const trigger = document.getElementById('generateReportButton');
          if (trigger) {
            trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return '#generateReportButton.click';
          }
        } catch {
          // ignore
        }
        return null;
      });
      console.log('[AimHarder] Fallback generar informe:', invoked || 'no disponible');
    }

    await page.waitForTimeout(1200).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    await page.waitForFunction(() => {
      const headers = Array.from(document.querySelectorAll('table th')).map((th) =>
        String(th.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim()
      );
      const hasTargetTable = headers.some((h) => h.includes('tarifas canceladas'));
      if (hasTargetTable) return true;

      const bodyText = String(document.body?.textContent || '').toLowerCase();
      return bodyText.includes('no hay resultados') || bodyText.includes('0 resultados');
    }, { timeout: 25000 }).catch(() => {});

    const tableDiagnostics = await page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const tables = Array.from(document.querySelectorAll('table'));
      return {
        url: window.location.href,
        tables: tables.slice(0, 6).map((table, idx) => {
          const headers = Array.from(table.querySelectorAll('th')).map((th) => normalize(th.textContent)).filter(Boolean);
          const rows = table.querySelectorAll('tbody tr').length || Math.max(0, table.querySelectorAll('tr').length - 1);
          return { idx, rows, headers: headers.slice(0, 10) };
        }),
        bodyHints: {
          hasTarifasCanceladasText: normalize(document.body?.textContent || '').includes('tarifas canceladas'),
          hasNoResults: normalize(document.body?.textContent || '').includes('no hay resultados') || normalize(document.body?.textContent || '').includes('0 resultados'),
        },
      };
    });
    console.log('[AimHarder] Diagnostico tablas:', JSON.stringify(tableDiagnostics));
    await snap('03-informe-generado');

    // Volcado de TODAS las tablas visibles (cabeceras + primeras filas), para
    // detectar si AimHarder cambió los nombres de columna / estructura.
    if (debug) {
      debugTables = await page.evaluate(() => {
        const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        return Array.from(document.querySelectorAll('table')).slice(0, 8).map((table, idx) => {
          const headers = Array.from(table.querySelectorAll('thead th, tr th')).map((th) => norm(th.textContent)).filter(Boolean);
          const bodyRows = Array.from(table.querySelectorAll('tbody tr')).length
            ? Array.from(table.querySelectorAll('tbody tr'))
            : Array.from(table.querySelectorAll('tr')).slice(1);
          const sampleRows = bodyRows.slice(0, 3).map((row) =>
            Array.from(row.querySelectorAll('td')).map((td) => norm(td.textContent))
          );
          // Diagnóstico del enlace al perfil: cid detectado, href del primer <a>,
          // src de la foto y el HTML real de la primera fila (base64 recortado).
          const stripB64 = (s) => String(s || '').replace(/data:image\/[^;]+;base64,[^"')\s]+/gi, 'data:img[B64]');
          const findCid = (html) => {
            const s = String(html || '');
            const m =
              s.match(/[?&]cid=(\d+)/i) ||
              s.match(/[?&](?:u|uid|user|userid|idcliente|clientid)=(\d{4,})/i) ||
              s.match(/\/(\d{5,})[^/]*\.(?:jpg|jpeg|png|webp|gif)/i);
            return m ? m[1] : '';
          };
          const sampleLinks = bodyRows.slice(0, 3).map((row) => ({
            cid: findCid(row.innerHTML),
            href: norm(row.querySelector('a')?.getAttribute('href') || ''),
            imgSrc: stripB64(row.querySelector('img')?.getAttribute('src') || '').slice(0, 200),
          }));
          const firstRowHtml = bodyRows[0] ? stripB64(bodyRows[0].innerHTML).slice(0, 2500) : '';
          return { idx, rowCount: bodyRows.length, headers, sampleRows, sampleLinks, firstRowHtml };
        });
      }).catch(() => []);
    }

    let clients = await parseTariffCancellationRows(page);

    // Fallback: algunos layouts de AimHarder renderizan el informe dentro de un iframe.
    if (!clients.length) {
      const frames = page.frames().filter((frame) => frame !== page.mainFrame());
      for (const frame of frames) {
        try {
          const frameClients = await parseTariffCancellationRows(frame);
          if (frameClients.length) {
            clients = frameClients;
            break;
          }
        } catch {
          // Ignorar frames no accesibles o sin contenido del informe
        }
      }
    }

    console.log(`[AimHarder] ${clients.length} clientes trimestral/semestral detectados`);

    return {
      startDate: range.startIso,
      endDate: range.endIso,
      clients,
      ...(debug ? { debug: { steps: debugSteps, tables: debugTables, parsedCount: clients.length } } : {}),
    };
  } finally {
    await browser.close();
    console.log('[AimHarder] ===== Fin scraping cancelaciones de tarifa =====');
  }
}

function stripAccents(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function isOnRampTariff(value) {
  const normalized = stripAccents(value).toLowerCase().replace(/\s+/g, ' ').trim();
  return normalized.includes('on ramp') || normalized.includes('onramp');
}

function isCrossfitTariff(value) {
  return /(medium|starter|iron|silver|gold|full)/i.test(stripAccents(value));
}

async function getTariffChangeReport(centerId, referenceDateStr = null, options = {}) {
  const config = await getCenterAimHarderConfig(centerId);

  if (!config.username || !config.password) {
    throw new Error(
      `Faltan credenciales de AimHarder para ${config.centerName}. Configura las credenciales en la integración del centro.`
    );
  }

  // Modo debug: captura pantallazos (base64) y un volcado de todas las tablas
  // que se ven en AimHarder, para diagnosticar cambios en su interfaz.
  const debug = Boolean(options.debug);
  const debugSteps = [];
  let debugTables = [];

  // Si el usuario elige un rango "desde/hasta" explícito, se usa tal cual en
  // AimHarder; si no, se cae al rango automático (última semana del mes + primera del siguiente).
  const range = (options.startDate && options.endDate)
    ? buildExplicitReportRange(options.startDate, options.endDate)
    : getTermRenewalReportRange(referenceDateStr);
  console.log('[AimHarder] ===== Scraping cambios de tarifa (on ramp -> crossfit) =====');
  console.log(`[AimHarder] Rango informe: ${range.startIso} -> ${range.endIso}`);

  const browser = await chromium.launch({ headless: true, slowMo: 0 });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const sessionCache = await getSessionCache(config);
    if (sessionCache.cookies && sessionCache.expiry && Date.now() < sessionCache.expiry) {
      await context.addCookies(sessionCache.cookies);
      console.log('[AimHarder] Sesión restaurada desde caché');
    }

    const page = await context.newPage();
    const reportsUrl = `${config.baseUrl}/reports`;

    // Captura un pantallazo (base64) del estado actual para el modo debug.
    const snap = async (label) => {
      if (!debug) return;
      try {
        const buffer = await page.screenshot({ fullPage: true });
        debugSteps.push({
          label,
          url: page.url(),
          image: `data:image/png;base64,${buffer.toString('base64')}`,
        });
      } catch (e) {
        debugSteps.push({ label, url: page.url(), error: e.message });
      }
    };

    // Esta tarea debe entrar directamente a Informes (no pasar por /control).
    console.log('[AimHarder] Navegando directamente a Informes...');
    await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    const initialReportsUrl = page.url();
    if (!isAuthenticatedAimHarderUrl(initialReportsUrl)) {
      console.log('[AimHarder] Sesión no válida en /reports, iniciando login...');
      await login(page, config);
      await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await dismissCookies(page);
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    }

    await setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    // Cerrar avisos promocionales que tapan botones (p. ej. rediseño del menú).
    await dismissAimHarderPromos(page);
    await snap('01-informes');

    // Paso 1: abrir explícitamente "Cambios de tarifa" desde Informes.
    const cambiosCard = page
      .locator('a, button')
      .filter({ hasText: /cambios de tarifa/i })
      .first();

    const cardCount = await cambiosCard.count();
    console.log(`[AimHarder] Card "Cambios de tarifa" detectada: ${cardCount > 0}`);

    if (!cardCount) {
      throw new Error('No se encontró la tarjeta de "Cambios de tarifa" en Informes');
    }

    const verMeta = await cambiosCard.evaluate((el) => ({
      tag: el.tagName,
      text: (el.textContent || '').trim(),
      id: el.id || null,
      className: el.className || null,
      href: el.getAttribute('href'),
      onclick: el.getAttribute('onclick'),
    })).catch(() => null);
    console.log('[AimHarder] Meta Cambios enlace:', verMeta);

    let clicked = false;
    try {
      await cambiosCard.click({ force: true, timeout: 8000 });
      clicked = true;
    } catch {
      clicked = false;
    }

    if (!clicked && verMeta?.onclick) {
      const invoked = await page.evaluate((onclickCode) => {
        try {
          // eslint-disable-next-line no-eval
          eval(onclickCode);
          return true;
        } catch {
          return false;
        }
      }, verMeta.onclick);
      console.log('[AimHarder] onclick Cambios ejecutado:', invoked);
    }

    await page.waitForTimeout(700).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    await page.waitForFunction(() => {
      const text = String(document.body?.textContent || '').toLowerCase();
      return text.includes('informes') && text.includes('cambios de tarifa') && text.includes('generar informe');
    }, { timeout: 20000 }).catch(() => {});

    const screenDiagnostics = await page.evaluate(() => {
      const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const lower = (v) => norm(v).toLowerCase();
      const bodyText = lower(document.body?.textContent || '');
      const breadcrumbRaw = Array.from(document.querySelectorAll('h1,h2,h3,h4,.breadcrumb,nav,div,span'))
        .map((el) => norm(el.textContent))
        .find((text) => lower(text).includes('informes') && lower(text).includes('cambios de tarifa')) || '';
      const hasChangePanel = bodyText.includes('descartar bonos') && bodyText.includes('grupo de tarifas');
      const breadcrumb = breadcrumbRaw.length > 220 ? `${breadcrumbRaw.slice(0, 220)}...` : breadcrumbRaw;
      return {
        url: window.location.href,
        breadcrumb,
        hasGenerateReportFn: typeof window.generateReport === 'function',
        hasChangePanel,
      };
    });
    console.log('[AimHarder] Diagnostico pantalla:', screenDiagnostics);
    await dismissAimHarderPromos(page);
    await snap('02-cambios-abierto');

    const evaluateResult = await page.evaluate(({ startInput, endInput }) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const parseEsDate = (value) => {
        const match = String(value || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!match) return null;
        const day = Number(match[1]);
        const month = Number(match[2]);
        const year = Number(match[3]);
        const date = new Date(year, month - 1, day);
        return Number.isNaN(date.getTime()) ? null : date;
      };

      const getFormScope = () => {
        const containers = Array.from(document.querySelectorAll('form, fieldset, .box, .panel, .card, section, div'));
        return containers.find((container) => {
          const text = normalize(container.textContent);
          return (
            text.includes('cambios de tarifa') &&
            text.includes('fechas') &&
            text.includes('desde') &&
            text.includes('hasta') &&
            text.includes('generar informe')
          );
        }) || null;
      };

      const getDateInputsFromFechasPanel = () => {
        const candidate = getFormScope();

        if (!candidate) return [];

        return Array.from(candidate.querySelectorAll('input[type="text"], input[type="date"]'))
          .filter((input) => {
            const style = window.getComputedStyle(input);
            return style.display !== 'none' && style.visibility !== 'hidden';
          });
      };

      const setDateInput = (input, value) => {
        if (!input) return;

        try {
          if (window.jQuery && window.jQuery.fn && typeof window.jQuery(input).datepicker === 'function') {
            const parsed = parseEsDate(value);
            window.jQuery(input).datepicker('setDate', parsed || value);
          }
        } catch {
          // fallback manual below
        }

        input.focus();
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
      };

      const dateInputsInDatePanel = getDateInputsFromFechasPanel();
      const fromInput = dateInputsInDatePanel[0] || null;
      const toInput = dateInputsInDatePanel[1] || null;

      if (fromInput && toInput) {
        setDateInput(fromInput, startInput);
        setDateInput(toInput, endInput);
      }

      const selects = Array.from(document.querySelectorAll('select'));
      for (const select of selects) {
        const labelText = normalize(
          (select.closest('label') && select.closest('label').textContent) ||
          (select.parentElement && select.parentElement.textContent) ||
          ''
        );
        const shouldSetNo = labelText.includes('descartar bonos') || labelText.includes('listar clientes');
        if (!shouldSetNo) continue;

        const noOption = Array.from(select.options).find((option) => normalize(option.textContent) === 'no');
        if (noOption) {
          select.value = noOption.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      const scope = getFormScope() || document;
      const triggerCandidates = Array.from(scope.querySelectorAll('button, input[type="button"], input[type="submit"], a'))
        .filter((el) => normalize(el.textContent || el.getAttribute('value')).includes('generar informe'));

      return {
        sameInputResolved: fromInput && toInput ? fromInput === toInput : false,
        scopeFound: !!scope,
        panelInputCount: dateInputsInDatePanel.length,
        fromFound: !!fromInput,
        toFound: !!toInput,
        fromValue: fromInput ? String(fromInput.value || '') : '',
        toValue: toInput ? String(toInput.value || '') : '',
        triggerFound: triggerCandidates.length > 0,
        triggerCount: triggerCandidates.length,
      };
    }, { startInput: range.startInput, endInput: range.endInput });

    console.log('[AimHarder] Resultado evaluate fechas:', {
      ...evaluateResult,
    });

    const dateDiagnostics = await page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const labels = Array.from(document.querySelectorAll('label, span, div, td, strong'));
      const fromLabel = labels.find((el) => normalize(el.textContent) === 'desde');
      const toLabel = labels.find((el) => normalize(el.textContent) === 'hasta');
      return {
        hasFromLabel: !!fromLabel,
        hasToLabel: !!toLabel,
      };
    });
    console.log('[AimHarder] Diagnostico fechas:', dateDiagnostics);

    // Paso 4: click real en el botón visible "Generar informe".
    // Cerrar de nuevo cualquier aviso flotante que pudiera tapar el botón.
    await dismissAimHarderPromos(page);
    const generateCandidates = page.locator('button, input[type="button"], input[type="submit"], a').filter({ hasText: /generar informe/i });
    const generateCount = await generateCandidates.count();
    console.log('[AimHarder] Botones generar informe visibles:', generateCount);
    let generated = false;
    if (generateCount > 0) {
      try {
        await generateCandidates.first().click({ force: true, timeout: 12000 });
        generated = true;
      } catch {
        generated = false;
      }
    }

    if (!generated) {
      const invoked = await page.evaluate(() => {
        try {
          if (typeof window.generateReport === 'function') {
            window.generateReport();
            return 'window.generateReport';
          }

          const trigger = document.getElementById('generateReportButton');
          if (trigger) {
            trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return '#generateReportButton.click';
          }
        } catch {
          // ignore
        }
        return null;
      });
      console.log('[AimHarder] Fallback generar informe:', invoked || 'no disponible');
    }

    await page.waitForTimeout(1200).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    await page.waitForFunction(() => {
      const headers = Array.from(document.querySelectorAll('table th')).map((th) =>
        String(th.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim()
      );
      const hasTargetTable = headers.some((h) => h.includes('nuevas tarifas'));
      if (hasTargetTable) return true;

      const bodyText = String(document.body?.textContent || '').toLowerCase();
      return bodyText.includes('no hay resultados') || bodyText.includes('0 resultados');
    }, { timeout: 25000 }).catch(() => {});

    const tableDiagnostics = await page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const tables = Array.from(document.querySelectorAll('table'));
      return {
        url: window.location.href,
        tables: tables.slice(0, 6).map((table, idx) => {
          const headers = Array.from(table.querySelectorAll('th')).map((th) => normalize(th.textContent)).filter(Boolean);
          const rows = table.querySelectorAll('tbody tr').length || Math.max(0, table.querySelectorAll('tr').length - 1);
          return { idx, rows, headers: headers.slice(0, 10) };
        }),
        bodyHints: {
          hasNuevasTarifasText: normalize(document.body?.textContent || '').includes('nuevas tarifas'),
          hasNoResults: normalize(document.body?.textContent || '').includes('no hay resultados') || normalize(document.body?.textContent || '').includes('0 resultados'),
        },
      };
    });
    console.log('[AimHarder] Diagnostico tablas:', JSON.stringify(tableDiagnostics));
    await snap('03-informe-generado');

    // Volcado de TODAS las tablas visibles (cabeceras + primeras filas), para
    // detectar si AimHarder cambió los nombres de columna / estructura.
    if (debug) {
      debugTables = await page.evaluate(() => {
        const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        return Array.from(document.querySelectorAll('table')).slice(0, 8).map((table, idx) => {
          const headers = Array.from(table.querySelectorAll('thead th, tr th')).map((th) => norm(th.textContent)).filter(Boolean);
          const bodyRows = Array.from(table.querySelectorAll('tbody tr')).length
            ? Array.from(table.querySelectorAll('tbody tr'))
            : Array.from(table.querySelectorAll('tr')).slice(1);
          const sampleRows = bodyRows.slice(0, 3).map((row) =>
            Array.from(row.querySelectorAll('td')).map((td) => norm(td.textContent))
          );
          // Diagnóstico del enlace al perfil: cid detectado, href del primer <a>,
          // src de la foto y el HTML real de la primera fila (base64 recortado).
          const stripB64 = (s) => String(s || '').replace(/data:image\/[^;]+;base64,[^"')\s]+/gi, 'data:img[B64]');
          const findCid = (html) => {
            const s = String(html || '');
            const m =
              s.match(/[?&]cid=(\d+)/i) ||
              s.match(/[?&](?:u|uid|user|userid|idcliente|clientid)=(\d{4,})/i) ||
              s.match(/\/(\d{5,})[^/]*\.(?:jpg|jpeg|png|webp|gif)/i);
            return m ? m[1] : '';
          };
          const sampleLinks = bodyRows.slice(0, 3).map((row) => ({
            cid: findCid(row.innerHTML),
            href: norm(row.querySelector('a')?.getAttribute('href') || ''),
            imgSrc: stripB64(row.querySelector('img')?.getAttribute('src') || '').slice(0, 200),
          }));
          const firstRowHtml = bodyRows[0] ? stripB64(bodyRows[0].innerHTML).slice(0, 2500) : '';
          return { idx, rowCount: bodyRows.length, headers, sampleRows, sampleLinks, firstRowHtml };
        });
      }).catch(() => []);
    }

    let allRows = await parseTariffChangeRows(page);

    // Fallback: algunos layouts de AimHarder renderizan el informe dentro de un iframe.
    if (!allRows.length) {
      const frames = page.frames().filter((frame) => frame !== page.mainFrame());
      for (const frame of frames) {
        try {
          const frameRows = await parseTariffChangeRows(frame);
          if (frameRows.length) {
            allRows = frameRows;
            break;
          }
        } catch {
          // Ignorar frames no accesibles o sin contenido del informe
        }
      }
    }

    // Convierte el href capturado del informe en una URL absoluta al perfil del
    // cliente en AimHarder (resuelto contra el dominio del box).
    const resolveProfileUrl = (href) => {
      if (!href || /^javascript:/i.test(href) || href === '#') return '';
      try {
        return new URL(href, config.baseUrl).toString();
      } catch {
        return '';
      }
    };

    // Cruce con "Clientes activos" (ya sincronizados por API) para obtener el cid
    // interno de AimHarder de forma fiable (funciona aunque el cliente no tenga
    // foto). Clave principal: teléfono (los 9 últimos dígitos); clave secundaria:
    // nombre normalizado. Se recorre todo el histórico y gana el sync más reciente.
    const phone9 = (value) => String(value || '').replace(/\D/g, '').slice(-9);
    const cidByPhone = new Map();
    const cidByName = new Map();
    try {
      const actives = await ActiveClient.find({ center: centerId })
        .select('normalizedName phone aimharderId reportDate')
        .sort({ reportDate: -1 })
        .lean();
      for (const ac of actives) {
        if (!ac.aimharderId) continue;
        const p = phone9(ac.phone);
        // El primer registro visto por clave gana (el más reciente, por el sort desc).
        if (p.length === 9 && !cidByPhone.has(p)) cidByPhone.set(p, ac.aimharderId);
        if (ac.normalizedName && !cidByName.has(ac.normalizedName)) cidByName.set(ac.normalizedName, ac.aimharderId);
      }
      console.log(`[AimHarder] Cruce clientes activos: ${cidByPhone.size} teléfonos, ${cidByName.size} nombres con cid`);
    } catch (e) {
      console.warn('[AimHarder] No se pudo cruzar con clientes activos:', e.message);
    }

    // La columna "Teléfonos" del informe puede traer varios números.
    const phoneCandidates = (value) => (String(value || '').match(/\d{9,}/g) || []).map((g) => g.slice(-9));

    const clients = allRows
      .filter((row) => isOnRampTariff(row.cancelledTariff) && isCrossfitTariff(row.newTariff))
      .map((row) => {
        const { profileHref, ...rest } = row;
        const nn = normalizeName(row.memberName || '');
        // 1º teléfono (fiable), 2º nombre normalizado, 3º cid de la foto del informe.
        const cidFromPhone = phoneCandidates(row.phone).map((c) => cidByPhone.get(c)).find(Boolean);
        const crossCid = cidFromPhone || cidByName.get(nn) || '';
        const profileUrl = crossCid
          ? resolveProfileUrl(`clients?cid=${crossCid}`)
          : resolveProfileUrl(profileHref);
        return { ...rest, profileUrl };
      });

    console.log(`[AimHarder] ${allRows.length} cambios de tarifa detectados, ${clients.length} on ramp -> crossfit`);

    return {
      startDate: range.startIso,
      endDate: range.endIso,
      clients,
      ...(debug ? { debug: { steps: debugSteps, tables: debugTables, parsedCount: allRows.length } } : {}),
    };
  } finally {
    await browser.close();
    console.log('[AimHarder] ===== Fin scraping cambios de tarifa =====');
  }
}

// Resumen global de los comentarios generales de clase para un centro, en un
// rango de fechas opcional. Aplana los savedClasses con comentario no vacío.
async function getClassCommentsSummary({ centerId, from = null, to = null }) {
  const query = { center: centerId };
  if (from && to) query.date = { $gte: from, $lte: to };
  else if (from) query.date = { $gte: from };
  else if (to) query.date = { $lte: to };

  const reports = await ClassReport.find(query)
    .populate('updatedBy', 'name email')
    .lean();

  const comments = [];
  for (const report of reports) {
    for (const savedClass of report.savedClasses || []) {
      const comment = String(savedClass.comment || '').trim();
      if (!comment) continue;
      comments.push({
        date: report.date,
        period: report.period,
        instructorName: report.instructorName,
        className: savedClass.className,
        classTime: savedClass.classTime,
        comment,
        updatedAt: savedClass.savedAt || report.updatedAt || null,
      });
    }
  }

  comments.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return String(a.classTime).localeCompare(String(b.classTime));
  });

  return { from, to, count: comments.length, comments };
}

module.exports = {
  getAbsences,
  getStoredAbsences,
  getAbsenceSnapshotsRange,
  refreshAndStoreAbsences,
  getStoredOccupancy,
  refreshAndStoreOccupancy,
  refreshAndStoreOccupancyRange,
  syncActiveClients,
  clearSessionCache,
  getStoredAimHarderIntegration,
  upsertAimHarderIntegration,
  seedAimHarderIntegrationsFromEnv,
  getClassReportContext,
  getClassReportStatus,
  parseCoachBookingsJson,
  occupancyFromCoachBookings,
  saveClassReport,
  getClassCommentsSummary,
  resetClassReportTask,
  setClassReportHandoffStatus,
  getPendingPaymentsWithTPVError,
  getPendingPaymentsWithoutTPVError,
  getActiveClientsMonthlyReport,
  getClientMonthlyReport,
  setClientMonthlyMetricsManual,
  resetClientMonthlySnapshot,
  getTariffCancellationRenewals,
  getTariffChangeReport,
  getYesterday,
  toDateString,
};
