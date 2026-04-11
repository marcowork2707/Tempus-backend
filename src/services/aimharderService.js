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
const AttendanceAbsenceSnapshot = require('../models/AttendanceAbsenceSnapshot');
const CenterOccupancySnapshot = require('../models/CenterOccupancySnapshot');
const ClassReport = require('../models/ClassReport');

// URL del portal principal de AimHarder (donde está el botón de login)
const LOGIN_URL = 'https://aimharder.com';
// URL directa del servicio de autenticación
const AUTH_URL = 'https://login.aimharder.com';
const API_BASE_URL = 'https://api.aimharder.com';
const DEBUG_DIR = path.join(__dirname, '../../debug');
const PLAYWRIGHT_DEBUG = false;

// ── Asegurarse de que el directorio de debug existe ──
if (PLAYWRIGHT_DEBUG && !fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// Cache de sesión por centro (cookies de AimHarder, no de Tempus)
const sessionCacheByCenter = new Map();
const SESSION_TTL_MS = 25 * 60 * 1000; // 25 min
const apiTokenCacheByCenter = new Map();

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
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return true;

  const leftTokens = normalizedLeft.split(' ').filter(Boolean);
  const rightTokens = normalizedRight.split(' ').filter(Boolean);
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

function getSessionCache(config) {
  return sessionCacheByCenter.get(config.cacheKey) || { cookies: null, expiry: null };
}

function setSessionCache(config, value) {
  sessionCacheByCenter.set(config.cacheKey, value);
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

async function openReservationsDay(page, targetDate, config) {
  const scheduleUrl = `${config.baseUrl}/schedule?adm`;
  console.log('[AimHarder] Navegando a schedule:', scheduleUrl);
  await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200).catch(() => {});
  await dismissCookies(page);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await saveDebugSnapshot(page, '04_schedule_today');

  await page.waitForSelector('#weekDays, #clasesDiaSel', { timeout: 20000 });

  const dayKey = toAimHarderDayKey(targetDate);
  const daySelector = `#weekDays .wds${dayKey}`;
  const targetDay = targetDate.getDate();

  console.log('[AimHarder] Seleccionando día objetivo:', dayKey);

  const directButton = page.locator(daySelector).first();
  if (await directButton.count()) {
    await directButton.click({ force: true });
  } else {
    console.log('[AimHarder] Botón semanal no encontrado, usando weekSelDay()');
    await page.evaluate((value) => {
      if (typeof window.weekSelDay === 'function') {
        window.weekSelDay(value);
      }
    }, dayKey);
  }

  await page.waitForTimeout(2000).catch(() => {});
  await page.waitForFunction(
    ({ selector, day }) => {
      const active = document.querySelector(`${selector}.active`);
      const title = document.querySelector('#clasesDiaSel .titRvClass')?.textContent || '';
      return Boolean(active) || title.includes(String(day));
    },
    { selector: daySelector, day: targetDay },
    { timeout: 20000 }
  ).catch(() => {});

  await dismissCookies(page);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await saveDebugSnapshot(page, `05_schedule_day${targetDay}`);
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

  const hasCancelText =
    /cancelad[oa]s?/i.test(normalizedText) ||
    /anulad[oa]s?/i.test(normalizedText) ||
    /\bcancel(ar|ada|ado|aci[oó]n)\b/i.test(normalizedText);

  const hasCancelIcon =
    $athlete.find('.checkAthlete img[src*="delete2.svg"], .checkAthlete img[src*="delete"], .checkAthlete img[src*="cancel"]').length > 0;

  const hasCancelMarker =
    athleteHtml.includes('cancel') ||
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

async function parseReservationsHtml(page, targetDate) {
  const cheerio = require('cheerio');
  const html = await page.content();
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

async function parseReservationsHtmlForOccupancy(page) {
  const cheerio = require('cheerio');
  const html = await page.content();
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

    if (!className && !classTime) return;

    classes.push({
      className,
      classTime,
      instructorName,
      roomName,
      bookedCount,
      attendanceCount,
      noShowCount,
      waitlistCount: waitlistMembers.length,
      waitlistMembers,
      capacity,
      occupancyRate: formatPercent(bookedCount, capacity),
      attendanceRate: formatPercent(attendanceCount, capacity),
    });
  });

  return classes.sort((a, b) => a.classTime.localeCompare(b.classTime));
}

async function parseReservationsHtmlForClassReports(page) {
  const cheerio = require('cheerio');
  const html = await page.content();
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
      const waitlistContainer = $athlete.closest(
        '[class*="espera"], [class*="wait"], [id*="espera"], [id*="wait"], .waitList, .listaEspera'
      );
      if (waitlistContainer.length) return;

      const hasAttendanceCheck =
        $athlete.find('.checkAthlete img[src*="check"], .checkAthlete img[src*="ok"], .checkAthlete img[src*="success"]').length > 0;
      if (!hasAttendanceCheck) return;

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

async function getClassReportContext(dateStr = null, centerId, userName = '', isAdmin = false, userId = null) {
  const config = await getCenterAimHarderConfig(centerId);
  const username = config.username;
  const password = config.password;

  if (!username || !password) {
    throw new Error(`Faltan credenciales de AimHarder para ${config.centerName}. Configúralas en la integración del centro.`);
  }

  const targetDate = dateStr ? new Date(`${dateStr}T12:00:00`) : new Date();
  const targetDateStr = toDateString(targetDate);
  const browser = await chromium.launch({ headless: true, slowMo: 0 });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const sessionCache = getSessionCache(config);
    if (sessionCache.cookies && sessionCache.expiry && Date.now() < sessionCache.expiry) {
      await context.addCookies(sessionCache.cookies);
    }

    const page = await context.newPage();
    await ensureAuthenticatedSession(page, config);

    setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    await openReservationsDay(page, targetDate, config);
    const reservationClasses = await parseReservationsHtmlForClassReports(page);
    const normalizedUserName = normalizeName(userName);
    const now = new Date();
    const nowMinutes = (now.getHours() * 60) + now.getMinutes();
    const isToday = targetDateStr === toDateString(new Date());

    const filteredClasses = isAdmin
      ? reservationClasses
      : reservationClasses.filter((item) => {
          return namesLikelyMatch(item.instructorName, normalizedUserName);
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

    return {
      date: targetDateStr,
      reports: Array.from(grouped.values()).map((group) => {
        const latestMinutes = Math.max(...group.classes.map((item) => toMinutes(item.classTime)));
        const ready = !isToday || latestMinutes <= nowMinutes;
        const saved = savedMap.get(`${normalizeName(group.instructorName)}::${group.period}`);
        const savedItems = new Map(
          (saved?.items || []).map((item) => [
            `${item.classTime}::${normalizeName(item.className)}::${normalizeName(item.memberName)}`,
            item,
          ])
        );

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
            members: classItem.members.map((member) => {
              const savedItem = savedItems.get(
                `${classItem.classTime}::${normalizeName(classItem.className)}::${normalizeName(member.memberName)}`
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

async function saveClassReport(data) {
  const {
    centerId,
    date,
    period,
    instructorName,
    instructorUserId = null,
    updatedBy,
    items = [],
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
      `${item.classTime}::${normalizeName(item.className)}::${normalizeName(item.memberName)}`,
      item,
    ])
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
        `${item.classTime}::${normalizeName(item.className)}::${normalizeName(item.memberName)}`
      );
      const sameNote = existingItem && String(existingItem.note || '').trim() === item.note;

      return {
        ...item,
        handoffDone: sameNote ? !!existingItem.handoffDone : false,
        handoffDoneBy: sameNote ? existingItem.handoffDoneBy || null : null,
        handoffDoneAt: sameNote ? existingItem.handoffDoneAt || null : null,
      };
    });

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
        items: normalizedItems,
        updatedBy,
        submittedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return report;
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
    const sessionCache = getSessionCache(config);
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
    setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    // ── Navegación al día ──
    await openReservationsDay(page, targetDate, config);
    await saveDebugSnapshot(page, '06_final_schedule');

    const reservationAbsences = await parseReservationsHtml(page, targetDate);
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

    const sessionCache = getSessionCache(config);
    if (sessionCache.cookies && sessionCache.expiry && Date.now() < sessionCache.expiry) {
      await context.addCookies(sessionCache.cookies);
      console.log('[AimHarder] Sesión restaurada desde caché');
    }

    const page = await context.newPage();
    await ensureAuthenticatedSession(page, config);

    setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    await openReservationsDay(page, targetDate, config);
    const classes = await parseReservationsHtmlForOccupancy(page);
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

module.exports = {
  getAbsences,
  getStoredAbsences,
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
  saveClassReport,
  setClassReportHandoffStatus,
  getYesterday,
  toDateString,
};
