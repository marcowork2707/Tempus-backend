/**
 * Script de diagnóstico — usa el servicio real con MongoDB y cookies cacheadas.
 * Ejecutar: node debug_retention.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const DEBUG_DIR = path.join(__dirname, 'debug');
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

const Center = require('./src/models/Center');
const { getClientRetentionRate } = require('./src/services/aimharderService');

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('ERROR: MONGODB_URI no definido'); process.exit(1); }

  console.log('[DB] Conectando a MongoDB Atlas...');
  await mongoose.connect(mongoUri);
  console.log('[DB] Conectado');

  const centers = await Center.find({}).select('_id name').lean();
  console.log(`[DB] Centros encontrados: ${centers.length}`);
  centers.forEach((c) => console.log(`  - ${c._id} | ${c.name}`));

  if (centers.length === 0) {
    console.error('[DB] Sin centros. Revisar conexión.');
    await mongoose.disconnect();
    return;
  }

  const target = centers.find((c) => /funcional/i.test(c.name)) || centers[0];
  console.log(`\n[TEST] Centro elegido: ${target._id} | ${target.name}`);
  console.log('[TEST] Llamando getClientRetentionRate...\n');

  try {
    const result = await getClientRetentionRate(target._id.toString());
    console.log('[OK] Resultado:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('[FAIL]', err.message);
    const files = fs.readdirSync(DEBUG_DIR).filter((f) => /retention|wrong/.test(f));
    if (files.length) {
      console.log('\nArchivos debug generados:');
      files.forEach((f) => console.log('  debug/' + f));
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
