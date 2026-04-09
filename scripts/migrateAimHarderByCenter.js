require('dotenv').config();
const mongoose = require('mongoose');
const Center = require('../src/models/Center');
const ActiveClient = require('../src/models/ActiveClient');
const AttendanceAbsenceSnapshot = require('../src/models/AttendanceAbsenceSnapshot');
const CenterOccupancySnapshot = require('../src/models/CenterOccupancySnapshot');

function normalize(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function dropIndexIfExists(collection, name) {
  const indexes = await collection.indexes();
  const exists = indexes.some((index) => index.name === name);
  if (exists) {
    await collection.dropIndex(name);
    console.log(`Indice eliminado: ${collection.collectionName}.${name}`);
  }
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const centers = await Center.find({});
  const tempusFuncional = centers.find((center) => normalize(center.name) === 'tempus funcional fitness');
  const crossfitTempus = centers.find((center) => normalize(center.name) === 'crossfit tempus');

  if (!tempusFuncional) {
    throw new Error('No se encontró el centro Tempus Funcional Fitness para migrar datos históricos');
  }

  tempusFuncional.aimharderKey = tempusFuncional.aimharderKey || 'TEMPUS_FUNCIONAL_FITNESS';
  await tempusFuncional.save();
  console.log(`Centro actualizado: ${tempusFuncional.name} -> ${tempusFuncional.aimharderKey}`);

  if (crossfitTempus) {
    crossfitTempus.aimharderKey = crossfitTempus.aimharderKey || 'CROSSFIT_TEMPUS';
    await crossfitTempus.save();
    console.log(`Centro actualizado: ${crossfitTempus.name} -> ${crossfitTempus.aimharderKey}`);
  }

  await ActiveClient.updateMany(
    { center: { $exists: false } },
    { $set: { center: tempusFuncional._id } }
  );
  await AttendanceAbsenceSnapshot.updateMany(
    { center: { $exists: false } },
    { $set: { center: tempusFuncional._id } }
  );
  await CenterOccupancySnapshot.updateMany(
    { center: { $exists: false } },
    { $set: { center: tempusFuncional._id } }
  );

  await dropIndexIfExists(ActiveClient.collection, 'reportDate_1_normalizedName_1');
  await dropIndexIfExists(AttendanceAbsenceSnapshot.collection, 'date_1');
  await dropIndexIfExists(CenterOccupancySnapshot.collection, 'date_1');

  await ActiveClient.collection.createIndex({ center: 1, reportDate: 1, normalizedName: 1 }, { unique: true });
  await AttendanceAbsenceSnapshot.collection.createIndex({ center: 1, date: 1 }, { unique: true });
  await CenterOccupancySnapshot.collection.createIndex({ center: 1, date: 1 }, { unique: true });

  console.log('Migración de AimHarder por centro completada');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect();
  process.exit(1);
});
