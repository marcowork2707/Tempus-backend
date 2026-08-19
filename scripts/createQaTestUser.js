/**
 * Crea (o reutiliza) un usuario temporal de QA con rol admin en ambos centros,
 * solo para verificar visualmente el módulo de Formación/Mensajes.
 * Ejecutar: node scripts/createQaTestUser.js
 * Borrar después con: node scripts/deleteQaTestUser.js
 */
require('dotenv').config();
const connectDB = require('../src/config/db');
const User = require('../src/models/User');
const Role = require('../src/models/Role');
const Center = require('../src/models/Center');
const UserCenterRole = require('../src/models/UserCenterRole');

const QA_EMAIL = 'qa-temporal@tempus.local';
const QA_PASSWORD = 'QaTemporal123!';
const QA_DNI = '00000000T';

async function run() {
  await connectDB();

  let user = await User.findOne({ email: QA_EMAIL });
  if (!user) {
    user = await User.create({
      firstName: 'QA',
      lastName: 'Temporal',
      name: 'QA Temporal',
      email: QA_EMAIL,
      dni: QA_DNI,
      password: QA_PASSWORD,
      active: true,
      invitationStatus: 'active',
      mustSetPassword: false,
    });
    console.log('✓ Usuario QA creado');
  } else {
    console.log('✓ Usuario QA ya existía, reutilizando');
  }

  const adminRole = await Role.findOne({ name: 'admin' });
  if (!adminRole) throw new Error('No existe el rol admin en la base de datos');

  const centers = await Center.find({});
  for (const center of centers) {
    const exists = await UserCenterRole.findOne({ user: user._id, center: center._id });
    if (!exists) {
      await UserCenterRole.create({ user: user._id, center: center._id, role: adminRole._id, active: true });
      console.log(`✓ Acceso admin concedido en ${center.name}`);
    }
  }

  console.log('\nCredenciales QA:');
  console.log('Email:', QA_EMAIL);
  console.log('Password:', QA_PASSWORD);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
