require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');

const connectDB = require('../src/config/db');
const User = require('../src/models/User');
const Center = require('../src/models/Center');
const Role = require('../src/models/Role');
const UserCenterRole = require('../src/models/UserCenterRole');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const STAFF_TO_IMPORT = [
  {
    firstName: 'Diego',
    lastName: 'Velosa',
    email: 'velosa70@gmail.com',
    dni: 'X2250002G',
    roleName: 'encargado',
    centerKey: 'funcional',
  },
  {
    firstName: 'Rodrigo',
    lastName: 'Martín',
    email: 'rodrima1405@gmail.com',
    dni: '03939978D',
    roleName: 'coach',
    centerKey: 'funcional',
  },
  {
    firstName: 'Sara',
    lastName: 'del Río',
    email: 'sarita1241@hotmail.com',
    dni: '03910988E',
    roleName: 'coach',
    centerKey: 'crossfit',
  },
  {
    firstName: 'Javier',
    lastName: 'Dapica',
    email: 'javierdapiteja@gmail.com',
    dni: '04860376Q',
    roleName: 'coach',
    centerKey: 'crossfit',
  },
  {
    firstName: 'Antonio Javier',
    lastName: 'Sánchez',
    email: 'tony_jsc@hotmail.com',
    dni: '03919863L',
    roleName: 'coach',
    centerKey: 'crossfit',
  },
  {
    firstName: 'Teresa',
    lastName: 'Ruiz',
    email: 'teresa.rsfv@gmail.com',
    dni: '03949831H',
    roleName: 'coach',
    centerKey: 'crossfit',
  },
  {
    firstName: 'Julia',
    lastName: 'Barroso',
    email: 'juliabarrosom13@gmail.com',
    dni: '04856770K',
    roleName: 'coach',
    centerKey: 'crossfit',
  },
  {
    firstName: 'Celia',
    lastName: 'Reoyos',
    email: 'celiarevi2005@gmail.com',
    dni: '04239917M',
    roleName: 'coach',
    centerKey: 'crossfit',
  },
];

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const createInvitation = () => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  return {
    rawToken,
    hashedToken: hashToken(rawToken),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    activationLink: `${FRONTEND_URL}/auth/activar-cuenta?token=${rawToken}`,
  };
};

const findCenterByKey = async (centerKey) => {
  if (centerKey === 'crossfit') {
    return Center.findOne({
      $or: [
        { type: /crossfit/i },
        { name: /crossfit tempus/i },
        { name: /crossfit/i },
      ],
    });
  }

  if (centerKey === 'funcional') {
    return Center.findOne({
      $or: [
        { type: /funcional/i },
        { name: /tempus funcional/i },
        { name: /funcional/i },
      ],
    });
  }

  return null;
};

const ensureAssignment = async (userId, centerId, roleId) => {
  const existing = await UserCenterRole.findOne({ user: userId, center: centerId });

  if (existing) {
    existing.role = roleId;
    await existing.save();
    return existing;
  }

  return UserCenterRole.create({
    user: userId,
    center: centerId,
    role: roleId,
  });
};

const importStaff = async () => {
  await connectDB();

  const roles = {
    coach: await Role.findOne({ name: 'coach' }),
    encargado: await Role.findOne({ name: 'encargado' }),
  };

  if (!roles.coach || !roles.encargado) {
    throw new Error('No se han encontrado los roles necesarios en la base de datos');
  }

  const centers = {
    crossfit: await findCenterByKey('crossfit'),
    funcional: await findCenterByKey('funcional'),
  };

  if (!centers.crossfit || !centers.funcional) {
    throw new Error('No se han encontrado los centros crossfit/funcional en la base de datos');
  }

  const results = [];

  for (const staff of STAFF_TO_IMPORT) {
    const center = centers[staff.centerKey];
    const role = roles[staff.roleName];

    let user = await User.findOne({ email: staff.email }).select('+activationToken +activationTokenExpires +password');
    let activationLink = null;
    let action = 'existing';

    if (!user) {
      const invitation = createInvitation();

      user = await User.create({
        firstName: staff.firstName,
        lastName: staff.lastName,
        name: `${staff.firstName} ${staff.lastName}`,
        email: staff.email,
        dni: staff.dni,
        password: invitation.rawToken,
        mustSetPassword: true,
        invitationStatus: 'pending',
        activationToken: invitation.hashedToken,
        activationTokenExpires: invitation.expiresAt,
        active: true,
      });

      activationLink = invitation.activationLink;
      action = 'created';
    } else {
      user.firstName = staff.firstName;
      user.lastName = staff.lastName;
      user.name = `${staff.firstName} ${staff.lastName}`;
      user.dni = staff.dni;

      if (user.invitationStatus === 'pending' || user.mustSetPassword) {
        const invitation = createInvitation();
        user.password = invitation.rawToken;
        user.mustSetPassword = true;
        user.invitationStatus = 'pending';
        user.activationToken = invitation.hashedToken;
        user.activationTokenExpires = invitation.expiresAt;
        activationLink = invitation.activationLink;
        action = 'updated-invitation';
      }

      await user.save();
    }

    await ensureAssignment(user._id, center._id, role._id);

    results.push({
      name: user.name,
      email: user.email,
      role: staff.roleName,
      center: center.name,
      action,
      activationLink,
    });
  }

  console.log('\nImportación completada:\n');
  results.forEach((item) => {
    console.log(`- ${item.name} | ${item.email} | ${item.role} | ${item.center} | ${item.action}`);
    if (item.activationLink) {
      console.log(`  Activación: ${item.activationLink}`);
    }
  });
};

importStaff()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Error importando personal invitado:', error);
    await mongoose.connection.close();
    process.exit(1);
  });
