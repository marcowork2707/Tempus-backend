/**
 * Borra el usuario temporal de QA y sus UserCenterRole. Solo afecta a ese usuario.
 * Ejecutar: node scripts/deleteQaTestUser.js
 */
require('dotenv').config();
const connectDB = require('../src/config/db');
const User = require('../src/models/User');
const UserCenterRole = require('../src/models/UserCenterRole');

const QA_EMAIL = 'qa-temporal@tempus.local';

async function run() {
  await connectDB();

  const user = await User.findOne({ email: QA_EMAIL });
  if (!user) {
    console.log('No existe el usuario QA, nada que borrar.');
    process.exit(0);
  }

  const { deletedCount: rolesDeleted } = await UserCenterRole.deleteMany({ user: user._id });
  await User.deleteOne({ _id: user._id });

  console.log(`✓ Usuario QA borrado (y ${rolesDeleted} UserCenterRole asociados).`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
