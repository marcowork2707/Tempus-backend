require('dotenv').config();

const connectDB = require('../src/config/db');
const Center = require('../src/models/Center');
const AimHarderIntegration = require('../src/models/AimHarderIntegration');

async function main() {
  const centerArg = process.argv[2] || null;

  await connectDB();

  let centers = [];

  if (centerArg) {
    let center = null;
    if (/^[0-9a-fA-F]{24}$/.test(centerArg)) {
      center = await Center.findById(centerArg).lean();
    } else {
      center = await Center.findOne({ name: centerArg }).lean();
    }

    if (!center) {
      throw new Error(`No se encontró centro para: ${centerArg}`);
    }

    centers = [center];
  } else {
    centers = await Center.find({ active: true }).lean();
  }

  for (const center of centers) {
    const integration = await AimHarderIntegration.findOne({ center: center._id });

    if (!integration) {
      console.log(`[CLEAN] Sin integración para ${center.name}`);
      continue;
    }

    await AimHarderIntegration.findByIdAndUpdate(integration._id, {
      $set: {
        sessionCookies: null,
        sessionExpiresAt: null,
      },
    });

    console.log(`[CLEAN] Sesión limpiada para ${center.name}`);
  }

  console.log('[CLEAN] Hecho. Espera ~15 min antes de reintentar si recibiste 403 Forbidden.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[CLEAN] Error:', error.message);
    process.exit(1);
  });
