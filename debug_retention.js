/**
 * Script de diagnóstico para el scraping de retención de AimHarder.
 * Ejecutar: node debug_retention.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const DEBUG_DIR = path.join(__dirname, 'debug');
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

const CONFIG = {
  baseUrl: 'https://tempusfunctionalfitness.aimharder.com',
  username: 'info@tempusfuncionalfitness.com',
  password: 'Miguel1909',
};

const LOGIN_URL = 'https://aimharder.com';
const AUTH_URL = 'https://login.aimharder.com/';

function isAuthenticatedAimHarderUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith('.aimharder.com') && parsed.hostname !== 'aimharder.com' && parsed.hostname !== 'login.aimharder.com';
  } catch {
    return false;
  }
}

async function dismissCookies(page) {
  try {
    const btn = page.locator('button:has-text("ACEPTAR TODAS"), button:has-text("Aceptar todas"), button:has-text("Accept all")').first();
    if (await btn.count()) await btn.click({ timeout: 3000 });
  } catch {}
}

async function save(page, label) {
  const ts = Date.now();
  const png = path.join(DEBUG_DIR, `${ts}_${label}.png`);
  const html = path.join(DEBUG_DIR, `${ts}_${label}.html`);
  await page.screenshot({ path: png, fullPage: true }).catch(() => {});
  const content = await page.content().catch(() => '');
  if (content) fs.writeFileSync(html, content, 'utf8');
  console.log(`[DEBUG] Screenshot: ${path.basename(png)}`);
}

async function doLogin(page) {
  console.log('[LOGIN] Navegando a aimharder.com...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await dismissCookies(page);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // Click "Iniciar sesión" en el nav
  const clicked = await page.evaluate(() => {
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
  console.log('[LOGIN] Nav link clicked:', clicked);

  if (!clicked || !page.url().includes('login.aimharder.com')) {
    await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }

  await dismissCookies(page);
  console.log('[LOGIN] Auth form URL:', page.url());

  // Fill credentials
  await page.locator('input[type="text"], input[type="email"], input[name="login"]').first().fill(CONFIG.username);
  await page.locator('input[type="password"]').first().fill(CONFIG.password);

  const submitted = await page.evaluate(() => {
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
  console.log('[LOGIN] Submit clicked:', submitted);

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000).catch(() => {});
  console.log('[LOGIN] URL tras submit:', page.url());

  // Always navigate to the center's control panel to finalize session
  console.log('[LOGIN] Navegando a control panel del box...');
  await page.goto(`${CONFIG.baseUrl}/control`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

  console.log('[LOGIN] URL post-login:', page.url());
  console.log('[LOGIN] Autenticado:', isAuthenticatedAimHarderUrl(page.url()));
  await save(page, 'after_login');
}

async function main() {
  const browser = await chromium.launch({ headless: true, slowMo: 0 });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // ---- STEP 1: Ir a /reports ----
    const reportsUrl = `${CONFIG.baseUrl}/reports`;
    console.log('[1] Navegando a /reports directamente...');
    await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    console.log('[1] URL actual:', page.url());

    // Si no estamos autenticados, hacer login
    if (!isAuthenticatedAimHarderUrl(page.url())) {
      console.log('[2] No autenticado, haciendo login...');
      await doLogin(page);
      // Volver a /reports
      console.log('[3] Volviendo a /reports tras login...');
      await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await dismissCookies(page);
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      console.log('[3] URL actual:', page.url());
    }

    await save(page, 'reports_page');
    console.log('[INFO] URL de la página de reports:', page.url());

    // ---- ANALIZAR DOM ----
    const domAnalysis = await page.evaluate(() => {
      const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isRetention = (t) => /retenci[oó]n\s+de\s+clientes/i.test(t);

      // Buscar todos los nodos con texto "retención de clientes"
      const allNodes = Array.from(document.querySelectorAll('*'));
      const retentionNodes = allNodes.filter((el) => {
        // Solo nodos que tengan el texto directamente (no hijos anidados)
        const directText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(' ');
        return isRetention(normalize(directText)) || (el.children.length === 0 && isRetention(normalize(el.textContent)));
      });

      const results = retentionNodes.slice(0, 10).map((node) => {
        // Subir hasta 8 niveles buscando "Ver informe"
        let container = node;
        let verInformeFound = null;
        for (let d = 0; d < 8 && container; d++) {
          const candidates = Array.from(container.querySelectorAll('a,button,input'));
          const match = candidates.find((el) => /ver\s+informe/i.test(String(el.textContent || el.value || '')));
          if (match) {
            verInformeFound = {
              depth: d,
              tagName: match.tagName,
              text: (match.textContent || match.value || '').trim().substring(0, 80),
              href: match.href || null,
              onclick: match.getAttribute('onclick') || null,
            };
            break;
          }
          container = container.parentElement;
        }

        // Listar todos los "Ver informe" dentro del padre más cercano de nivel 3
        let parent3 = node;
        for (let i = 0; i < 3 && parent3?.parentElement; i++) parent3 = parent3.parentElement;
        const siblings = parent3 ? Array.from(parent3.querySelectorAll('a,button')).map((el) => ({
          tag: el.tagName,
          text: (el.textContent || '').trim().substring(0, 80),
          href: el.href || null,
        })) : [];

        return {
          tag: node.tagName,
          className: node.className,
          ownText: node.textContent?.trim().substring(0, 120),
          parentTag: node.parentElement?.tagName,
          parentClass: node.parentElement?.className,
          verInformeFound,
          siblingsInParent3: siblings,
        };
      });

      // También buscar TODOS los "Ver informe" en la página con contexto
      const allVerInforme = Array.from(document.querySelectorAll('a,button'))
        .filter((el) => /ver\s+informe/i.test(String(el.textContent || '')))
        .map((el) => ({
          tag: el.tagName,
          text: el.textContent?.trim().substring(0, 80),
          href: el.href || null,
          onclick: el.getAttribute('onclick') || null,
          parentTag: el.parentElement?.tagName,
          parentText: el.parentElement?.textContent?.trim().substring(0, 200),
        }));

      // Texto visible completo de la página (primeros 3000 chars)
      const visibleText = String(document.body?.innerText || '').substring(0, 3000);

      return { retentionNodes: results, allVerInforme, visibleText };
    });

    console.log('\n===== ANÁLISIS DOM =====');
    console.log('Nodos con "Retención de clientes" encontrados:', domAnalysis.retentionNodes.length);
    domAnalysis.retentionNodes.forEach((n, i) => {
      console.log(`\n  [Nodo ${i}] <${n.tag}> class="${n.className}"`);
      console.log(`    Texto: ${n.ownText}`);
      console.log(`    Padre: <${n.parentTag}> class="${n.parentClass}"`);
      console.log(`    Ver informe encontrado:`, JSON.stringify(n.verInformeFound));
      console.log(`    Hermanos en parent[3]:`, JSON.stringify(n.siblingsInParent3));
    });

    console.log('\n===== TODOS LOS "VER INFORME" EN LA PÁGINA =====');
    domAnalysis.allVerInforme.forEach((vi, i) => {
      console.log(`\n  [VerInforme ${i}] <${vi.tag}> "${vi.text}"`);
      console.log(`    href: ${vi.href}`);
      console.log(`    onclick: ${vi.onclick}`);
      console.log(`    Padre: <${vi.parentTag}>`);
      console.log(`    Texto padre: ${vi.parentText?.substring(0, 200)}`);
    });

    console.log('\n===== TEXTO VISIBLE (primeros 3000 chars) =====');
    console.log(domAnalysis.visibleText);

    // ---- INTENTAR CLICK Y VER QUÉ PASA ----
    if (domAnalysis.retentionNodes.length > 0 && domAnalysis.retentionNodes[0].verInformeFound) {
      console.log('\n[4] Intentando click en "Ver informe" de retención...');

      const clicked = await page.evaluate(() => {
        const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isRetention = (t) => /retenci[oó]n\s+de\s+clientes/i.test(t);

        const allNodes = Array.from(document.querySelectorAll('*'));
        const retentionNodes = allNodes.filter((el) => {
          const directText = Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent)
            .join(' ');
          return isRetention(normalize(directText)) || (el.children.length === 0 && isRetention(normalize(el.textContent)));
        });

        for (const node of retentionNodes) {
          let container = node;
          for (let d = 0; d < 8 && container; d++) {
            const candidates = Array.from(container.querySelectorAll('a,button'));
            const match = candidates.find((el) => /ver\s+informe/i.test(String(el.textContent || '')));
            if (match) {
              match.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              return { clicked: true, depth: d, text: match.textContent?.trim(), href: match.href };
            }
            container = container.parentElement;
          }
        }
        return { clicked: false };
      });

      console.log('[4] Resultado click:', JSON.stringify(clicked));

      await page.waitForTimeout(2000).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await save(page, 'after_retention_click');
      console.log('[4] URL tras click:', page.url());

      const pageText = await page.evaluate(() => String(document.body?.innerText || '').substring(0, 2000));
      console.log('\n[4] Texto de la página tras click (primeros 2000):');
      console.log(pageText);

      const checks = await page.evaluate(() => {
        const t = String(document.body?.innerText || '').toLowerCase();
        return {
          hasRetentionClientes: t.includes('retención de clientes') || t.includes('retencion de clientes'),
          hasGenerarInforme: t.includes('generar informe'),
          hasFechas: t.includes('fechas'),
          hasEsteMes: t.includes('este mes'),
          hasRetentionMedia: t.includes('retención media') || t.includes('retencion media'),
        };
      });
      console.log('\n[4] Checks de pantalla:', JSON.stringify(checks, null, 2));
    } else {
      console.log('\n[!] No se encontró nodo de retención o no tiene "Ver informe" asociado.');
    }

  } finally {
    await browser.close();
    console.log('\n[FIN] Browser cerrado.');
  }
}

main().catch((err) => {
  console.error('[ERROR FATAL]', err.message);
  process.exit(1);
});
