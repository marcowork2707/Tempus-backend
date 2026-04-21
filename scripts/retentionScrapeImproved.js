// Función mejorada para obtener retención de clientes
// Insertarla en aimharderService.js
async function getClientRetentionRate_IMPROVED(centerId) {
  const config = await getCenterAimHarderConfig(centerId);

  if (!config.username || !config.password) {
    throw new Error(
      `Faltan credenciales de AimHarder para ${config.centerName}. Configura las credenciales en la integración del centro.`
    );
  }

  console.log('[AimHarder] ===== Scraping retención de clientes (mejorado) =====');

  const browser = await chromium.launch({ headless: true, slowMo: 0 });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const sessionCache = await getSessionCache(config);
    if (sessionCache.cookies && sessionCache.expiry && Date.now() < sessionCache.expiry) {
      await context.addCookies(sessionCache.cookies);
      console.log('[AimHarder] Sesión restaurada desde caché');
    }

    const page = await context.newPage();
    
    // Step 1: Navigate to reports
    console.log('[AimHarder] Navegando a /reports...');
    await page.goto(`${config.baseUrl}/reports`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissCookies(page);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    // Check if authenticated
    if (!isAuthenticatedAimHarderUrl(page.url())) {
      console.log('[AimHarder] No autenticado, haciendo login...');
      await login(page, config);
      await page.goto(`${config.baseUrl}/reports`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await dismissCookies(page);
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    }

    // Save session
    await setSessionCache(config, {
      cookies: await context.cookies(),
      expiry: Date.now() + SESSION_TTL_MS,
    });

    // Step 2: Take screenshot of reports page
    await page.screenshot({ path: `${DEBUG_DIR}/1_retention_reports_page.png` }).catch(() => {});
    const reportsPageText = await page.evaluate(() => document.body?.textContent || '');
    console.log('[AimHarder] Reports page first 1000 chars:', reportsPageText.slice(0, 1000));

    // Step 3: Look for retention card more flexibly
    console.log('[AimHarder] Buscando tarjeta de Retención...');
    
    // Try different selectors
    const retentionLinks = await page.locator('a, button, div[onclick], [class*="card"], [class*="box"], [class*="item"]').all();
    console.log(`[AimHarder] Encontrados ${retentionLinks.length} elementos clickeables`);

    let clicked = false;
    for (const link of retentionLinks) {
      const text = await link.textContent().catch(() => '');
      if (text.toLowerCase().includes('retención')) {
        console.log(`[AimHarder] Encontrada tarjeta: "${text.trim()}"`);
        try {
          await link.click({ force: true, timeout: 8000 });
          clicked = true;
          console.log('[AimHarder] Clic realizado');
          break;
        } catch (err) {
          console.log('[AimHarder] Clic fallido, intentando siguiente...');
        }
      }
    }

    if (!clicked) {
      console.log('[AimHarder] No se encontró tarjeta de retención');
      // Continue anyway - maybe it loads differently
    }

    await page.waitForTimeout(1000).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Step 4: Take screenshot after click
    await page.screenshot({ path: `${DEBUG_DIR}/2_retention_after_click.png` }).catch(() => {});

    // Step 5: Look for "Generar informe" button
    console.log('[AimHarder] Buscando botón "Generar informe"...');
    const generateBtn = await page.locator('button, input[type="button"], input[type="submit"], a').filter({ hasText: /generar.*informe|generate.*report/i }).first();
    const btnCount = await generateBtn.count();
    
    if (btnCount > 0) {
      console.log('[AimHarder] Botón encontrado, haciendo clic...');
      try {
        await generateBtn.click({ force: true, timeout: 12000 });
      } catch (err) {
        console.log('[AimHarder] Clic al botón falló:', err.message);
      }
    } else {
      console.log('[AimHarder] Botón "Generar informe" no encontrado');
    }

    await page.waitForTimeout(2000).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});

    // Step 6: Take screenshot of report
    await page.screenshot({ path: `${DEBUG_DIR}/3_retention_report.png` }).catch(() => {});

    // Step 7: Extract retention value with multiple strategies
    console.log('[AimHarder] Extrayendo valor de retención...');
    const retentionValue = await page.evaluate(() => {
      const bodyText = String(document.body?.textContent || '');
      const lines = bodyText.split('\n');
      
      console.log('[extraction] Total líneas:', lines.length);

      // Strategy 1: Buscar "retención" + número con unidad
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();
        if (line.includes('retención') || line.includes('retention')) {
          console.log(`[extraction] Línea ${i}: "${lines[i].slice(0, 80)}"`);
          
          // Check this line and next for numbers
          let searchText = lines[i];
          if (i + 1 < lines.length) searchText += ' ' + lines[i + 1];
          
          // Look for number with optional decimal
          const matches = searchText.match(/(\d+(?:[.,]\d+)?)\s*(?:días|days|%)?/g);
          if (matches) {
            const firstNum = matches[0];
            const numValue = firstNum.match(/\d+(?:[.,]\d+)?/);
            if (numValue) {
              const val = Number.parseFloat(numValue[0].replace(',', '.'));
              if (!isNaN(val)) {
                console.log(`[extraction] Valor encontrado en línea ${i}: ${val}`);
                return val;
              }
            }
          }
        }
      }

      // Strategy 2: Buscar cualquier número seguido de "días"
      const daysMatch = bodyText.match(/(\\d+(?:[.,]\\d+)?)\\s*(?:días|days)/i);
      if (daysMatch) {
        const val = Number.parseFloat(daysMatch[1].replace(',', '.'));
        if (!isNaN(val)) {
          console.log('[extraction] Valor encontrado con patrón "días":', val);
          return val;
        }
      }

      console.log('[extraction] No se encontró ningún valor de retención');
      return null;
    });

    if (retentionValue === null) {
      const pageText = await page.evaluate(() => document.body?.textContent || '');
      console.log('[AimHarder] ❌ No se pudo extraer retención. Contenido de la página (primeros 2000 chars):');
      console.log(pageText.slice(0, 2000));
      throw new Error('No se pudo extraer el valor de retención media de AimHarder. Revisa /debug/ para capturas.');
    }

    console.log(`[AimHarder] ✅ Retención media: ${retentionValue} días`);

    return {
      monthlyRetention: retentionValue,
      dailyRetention: retentionValue,
    };
  } finally {
    await browser.close();
    console.log('[AimHarder] ===== Fin scraping retención =====');
  }
}
