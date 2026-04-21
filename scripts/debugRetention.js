#!/usr/bin/env node
/**
 * Script de debug para el scraping de retención de clientes
 */

require('dotenv').config({ path: `${__dirname}/../.env` });
const { getClientRetentionRate } = require('../src/services/aimharderService');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/tempus';

async function test() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('TEST: Debug Retención de Clientes');
  console.log('═══════════════════════════════════════════════════════\n');

  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado a MongoDB\n');

    const Center = require('../src/models/Center');
    const centers = await Center.find().limit(1);

    if (!centers.length) {
      console.error('❌ No hay centros en la BD');
      process.exit(1);
    }

    const center = centers[0];
    const centerId = center._id.toString();
    console.log(`📍 Usando centro: ${center.name}\n`);

    console.log('Intentando cargar retención...\n');
    const result = await getClientRetentionRate(centerId);
    
    console.log('\n✅ ¡Éxito!');
    console.log('Resultado:', result);
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    console.error('\nStack completo:', err.stack);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

test();
