require('dotenv').config();

const connectDB = require('../src/config/db');
const Center = require('../src/models/Center');
const { getClientMonthlyReport } = require('../src/services/aimharderService');

async function main() {
  const centerArg = process.argv[2] || 'CrossFit Tempus';
  const monthArg = process.argv[3] || new Date().toISOString().slice(0, 7);

  await connectDB();

  let center = null;
  if (/^[0-9a-fA-F]{24}$/.test(centerArg)) {
    center = await Center.findById(centerArg).lean();
  } else {
    center = await Center.findOne({ name: centerArg }).lean();
  }

  if (!center) {
    throw new Error(`No se encontró centro para: ${centerArg}`);
  }

  console.log(`[DEBUG] Centro: ${center.name} (${center._id})`);
  console.log(`[DEBUG] Mes: ${monthArg}`);

  const result = await getClientMonthlyReport(String(center._id), monthArg, { refresh: true });

  console.log('[DEBUG] Resultado:');
  console.log(JSON.stringify({
    month: result.month,
    count: result.count,
    newSignups: result.newSignups,
    monthlyCancellations: result.monthlyCancellations,
    tariffSummaryTop5: (result.tariffSummary || []).slice(0, 5),
    fromCache: result.fromCache,
    hasData: result.hasData,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[DEBUG] Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  });
