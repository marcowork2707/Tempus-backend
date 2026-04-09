require('dotenv').config();
const mongoose = require('mongoose');
const Role = require('./src/models/Role');
const Center = require('./src/models/Center');
const User = require('./src/models/User');
const UserCenterRole = require('./src/models/UserCenterRole');
const Shift = require('./src/models/Shift');

const connectDB = require('./src/config/db');

const seedDatabase = async () => {
  try {
    await connectDB();

    // Clear existing data
    await Role.deleteMany({});
    await Center.deleteMany({});
    await User.deleteMany({});
    await UserCenterRole.deleteMany({});
    await Shift.deleteMany({});

    console.log('Cleared existing data');

    // Create Roles
    const admin = await Role.create({
      name: 'admin',
      description: 'Administrator with full access',
      permissions: [
        'manage_users',
        'manage_centers',
        'manage_tasks',
        'view_all',
        'edit_all',
        'view_audit_logs',
      ],
    });

    const encargado = await Role.create({
      name: 'encargado',
      description: 'Manager - Supervises center operations',
      permissions: [
        'view_center_tasks',
        'assign_shifts',
        'supervise_tasks',
        'mark_tasks',
        'view_center_history',
      ],
    });

    const coach = await Role.create({
      name: 'coach',
      description: 'Coach - Completes daily tasks',
      permissions: [
        'view_own_tasks',
        'complete_tasks',
        'view_checklist',
        'add_notes',
      ],
    });

    console.log('✓ Roles created');

    // Create Centers
    const centerCrossFit = await Center.create({
      name: 'CrossFit Box',
      type: 'crossfit',
      address: '123 Main St',
      phone: '+34 911 234 567',
      email: 'crossfit@tempus.local',
      active: true,
    });

    const centerFuncional = await Center.create({
      name: 'Funcional Center',
      type: 'funcional',
      address: '456 Oak Ave',
      phone: '+34 922 345 678',
      email: 'funcional@tempus.local',
      active: true,
    });

    console.log('✓ Centers created');

    // Create Shifts
    const shiftMorning = await Shift.create({
      center: centerCrossFit._id,
      name: 'Morning',
      startTime: '06:00',
      endTime: '14:00',
      active: true,
    });

    const shiftAfternoon = await Shift.create({
      center: centerCrossFit._id,
      name: 'Afternoon',
      startTime: '14:00',
      endTime: '22:00',
      active: true,
    });

    const shiftNight = await Shift.create({
      center: centerCrossFit._id,
      name: 'Night',
      startTime: '22:00',
      endTime: '06:00',
      active: true,
    });

    console.log('✓ Shifts created');

    // Create Users
    const adminUser = await User.create({
      firstName: 'Admin',
      lastName: 'User',
      name: 'Admin User',
      email: 'admin@tempus.local',
      password: 'password123',
      dni: '12345678A',
      active: true,
    });

    const encargadoUser = await User.create({
      firstName: 'Manager',
      lastName: 'CrossFit',
      name: 'Manager CrossFit',
      email: 'manager@tempus.local',
      password: 'password123',
      dni: '87654321B',
      active: true,
    });

    const coachUser1 = await User.create({
      firstName: 'Coach',
      lastName: 'One',
      name: 'Coach 1',
      email: 'coach1@tempus.local',
      password: 'password123',
      dni: '11111111C',
      active: true,
    });

    const coachUser2 = await User.create({
      firstName: 'Coach',
      lastName: 'Two',
      name: 'Coach 2',
      email: 'coach2@tempus.local',
      password: 'password123',
      dni: '22222222D',
      active: true,
    });

    const coachUser3 = await User.create({
      firstName: 'Coach',
      lastName: 'Funcional',
      name: 'Coach Funcional',
      email: 'coach.funcional@tempus.local',
      password: 'password123',
      dni: '33333333E',
      active: true,
    });

    console.log('✓ Users created');

    // Assign users to centers with roles
    await UserCenterRole.create({
      user: adminUser._id,
      center: centerCrossFit._id,
      role: admin._id,
    });

    await UserCenterRole.create({
      user: adminUser._id,
      center: centerFuncional._id,
      role: admin._id,
    });

    await UserCenterRole.create({
      user: encargadoUser._id,
      center: centerCrossFit._id,
      role: encargado._id,
    });

    await UserCenterRole.create({
      user: coachUser1._id,
      center: centerCrossFit._id,
      role: coach._id,
    });

    await UserCenterRole.create({
      user: coachUser2._id,
      center: centerCrossFit._id,
      role: coach._id,
    });

    await UserCenterRole.create({
      user: coachUser3._id,
      center: centerFuncional._id,
      role: coach._id,
    });

    console.log('✓ User-Center-Role assignments created');

    console.log('\n✓ Database seeded successfully!');
    console.log('\nTest Credentials:');
    console.log('Admin: admin@tempus.local / password123');
    console.log('Manager: manager@tempus.local / password123');
    console.log('Coach: coach1@tempus.local / password123');

    process.exit(0);
  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1);
  }
};

seedDatabase();
