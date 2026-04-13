const User = require('../models/User');
const Center = require('../models/Center');
const UserCenterRole = require('../models/UserCenterRole');
const Role = require('../models/Role');
const TimeEntry = require('../models/TimeEntry');
const WorkerShift = require('../models/WorkerShift');
const ShiftPattern = require('../models/ShiftPattern');
const ShiftOverride = require('../models/ShiftOverride');
const VacationRequest = require('../models/VacationRequest');
const VacationConflictRule = require('../models/VacationConflictRule');
const Checklist = require('../models/Checklist');
const ClassReport = require('../models/ClassReport');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const TaskInstance = require('../models/TaskInstance');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');
const { createInvitation } = require('./authController');
const { sendInvitationEmail } = require('../utils/email');
const crypto = require('crypto');

const ROLE_LABEL_BY_NAME = {
  coach: 'coach',
  encargado: 'encargado',
  admin: 'administrador',
};

const buildAssignmentPayload = async (userId) => {
  const assignments = await UserCenterRole.find({ user: userId })
    .populate('center')
    .populate('role');

  return assignments.map((assignment) => ({
    _id: assignment._id,
    centerId: assignment.center?._id,
    centerName: assignment.center?.name,
    centerType: assignment.center?.type,
    roleId: assignment.role?._id,
    roleName: assignment.role?.name,
  }));
};

const sendUserInvitation = async (user, assignedCenters) => {
  const invitation = createInvitation();

  user.password = invitation.rawToken;
  user.mustSetPassword = true;
  user.invitationStatus = 'pending';
  user.activationToken = invitation.hashedToken;
  user.activationTokenExpires = invitation.expiresAt;
  await user.save();

  const primaryAssignment = assignedCenters[0];
  const invitationEmail = await sendInvitationEmail({
    to: user.email,
    firstName: user.firstName,
    centerName: primaryAssignment?.centerName || 'Tempus',
    roleLabel:
      ROLE_LABEL_BY_NAME[primaryAssignment?.roleName] ||
      primaryAssignment?.roleName ||
      'usuario',
    activationLink: invitation.activationLink,
    expiresAt: invitation.expiresAt,
  });

  return {
    activationLink: invitation.activationLink,
    expiresAt: invitation.expiresAt,
    emailSent: Boolean(invitationEmail?.sent),
    emailError: invitationEmail?.reason || null,
  };
};

// Get All Users (Admin only)
exports.getAllUsers = catchAsyncErrors(async (req, res, next) => {
  const users = await User.find().sort({ createdAt: -1 });
  const assignmentsByUser = await Promise.all(
    users.map(async (user) => ({
      userId: user._id.toString(),
      assignments: await buildAssignmentPayload(user._id),
    }))
  );

  const usersWithAssignments = users.map((user) => ({
    ...user.toObject(),
    assignments:
      assignmentsByUser.find((entry) => entry.userId === user._id.toString())?.assignments || [],
  }));

  res.status(200).json({
    success: true,
    count: usersWithAssignments.length,
    users: usersWithAssignments,
  });
});

// Get User by ID
exports.getUserById = catchAsyncErrors(async (req, res, next) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(new ErrorHandler('User not found', 404));
  }

  // Get user's centers and roles
  const userCenterRoles = await buildAssignmentPayload(user._id);

  res.status(200).json({
    success: true,
    user,
    centerRoles: userCenterRoles,
  });
});

// Create User (Admin only)
exports.createUser = catchAsyncErrors(async (req, res, next) => {
  const { firstName, lastName, name, email, password, dni, centers } = req.body;

  if (!firstName || !lastName || !email || !dni) {
    return next(
      new ErrorHandler('Please provide firstName, lastName, email and dni', 400)
    );
  }

  let user = await User.findOne({ email });

  if (user) {
    return next(new ErrorHandler('User already exists with this email', 400));
  }

  const existingDni = await User.findOne({ dni });
  if (existingDni) {
    return next(new ErrorHandler('User already exists with this DNI', 400));
  }

  const isInvitedUser = !password;

  user = await User.create({
    firstName,
    lastName,
    name: name || `${firstName} ${lastName}`,
    email: email.toLowerCase().trim(),
    password: password || crypto.randomBytes(12).toString('hex'),
    dni: dni.toUpperCase().trim(),
    mustSetPassword: false,
    invitationStatus: 'active',
    activationToken: null,
    activationTokenExpires: null,
  });

  const assignedCenters = [];

  // Assign user to centers with roles if provided
  if (centers && centers.length > 0) {
    for (const center of centers) {
      let roleId = center.roleId;
      let roleName = center.roleName;

      if (!roleId && center.roleName) {
        const role = await Role.findOne({ name: center.roleName });
        if (!role) {
          return next(new ErrorHandler(`Role '${center.roleName}' not found`, 404));
        }
        roleId = role._id;
        roleName = role.name;
      }

      if (!roleId) {
        return next(new ErrorHandler('Each center assignment requires roleId or roleName', 400));
      }

      const centerDoc = await Center.findById(center.centerId);
      if (!centerDoc) {
        return next(new ErrorHandler('Center not found', 404));
      }

      await UserCenterRole.create({
        user: user._id,
        center: center.centerId,
        role: roleId,
      });

      assignedCenters.push({
        centerId: center.centerId,
        centerName: centerDoc.name,
        roleName,
      });
    }
  }

  const invitation = isInvitedUser
    ? await sendUserInvitation(user, assignedCenters)
    : null;

  res.status(201).json({
    success: true,
    message: invitation
      ? invitation.emailSent
        ? 'Invitación enviada correctamente'
        : 'Usuario invitado creado. No se pudo enviar el email automáticamente'
      : 'User created successfully',
    user,
    invitation: invitation
      ? invitation
      : null,
  });
});

// Update User (Admin only)
exports.updateUser = catchAsyncErrors(async (req, res, next) => {
  const { name, email, active, firstName, lastName, dni } = req.body;

  let user = await User.findById(req.params.id);

  if (!user) {
    return next(new ErrorHandler('User not found', 404));
  }

  if (name) user.name = name;
  if (firstName) user.firstName = firstName;
  if (lastName) user.lastName = lastName;
  if (email) user.email = email.toLowerCase().trim();
  if (dni) user.dni = dni.toUpperCase().trim();
  if (active !== undefined) user.active = active;
  if (req.body.nickname !== undefined) user.nickname = req.body.nickname;

  await user.save();

  res.status(200).json({
    success: true,
    message: 'User updated successfully',
    user,
  });
});

exports.resendInvitation = catchAsyncErrors(async (req, res, next) => {
  const user = await User.findById(req.params.id).select(
    '+activationToken +activationTokenExpires +password'
  );

  if (!user) {
    return next(new ErrorHandler('User not found', 404));
  }

  const assignedCenters = await buildAssignmentPayload(user._id);
  const invitation = await sendUserInvitation(user, assignedCenters);

  res.status(200).json({
    success: true,
    message: invitation.emailSent
      ? 'Invitación reenviada correctamente'
      : 'Invitación regenerada. No se pudo enviar el email automáticamente',
    invitation,
  });
});

// Delete User (Admin only)
exports.deleteUser = catchAsyncErrors(async (req, res, next) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(new ErrorHandler('User not found', 404));
  }

  const userId = user._id;

  // Delete or detach all user-linked records
  await UserCenterRole.deleteMany({ user: user._id });
  await TimeEntry.deleteMany({ user: userId });
  await WorkerShift.deleteMany({ user: userId });
  await ShiftPattern.deleteMany({ user: userId });
  await ShiftOverride.deleteMany({ user: userId });
  await VacationRequest.deleteMany({ user: userId });
  await VacationConflictRule.deleteMany({
    $or: [{ primaryUser: userId }, { blockedUser: userId }],
  });
  await Notification.deleteMany({ user: userId });
  await AuditLog.deleteMany({ user: userId });
  await TaskInstance.deleteMany({
    $or: [{ assignedTo: userId }, { completedBy: userId }],
  });

  await Checklist.updateMany(
    { assignedUser: userId },
    { $set: { assignedUser: null } }
  );
  await Checklist.updateMany(
    { reviewedBy: userId },
    { $unset: { reviewedBy: '', reviewedAt: '' } }
  );
  await Checklist.updateMany(
    { 'items.doneBy': userId },
    {
      $set: {
        'items.$[item].doneBy': null,
        'items.$[item].doneAt': null,
        'items.$[item].done': false,
      },
    },
    {
      arrayFilters: [{ 'item.doneBy': userId }],
    }
  );

  await ClassReport.updateMany(
    { instructorUser: userId },
    { $set: { instructorUser: null } }
  );
  await ClassReport.updateMany(
    { updatedBy: userId },
    { $set: { updatedBy: null } }
  );
  await ClassReport.updateMany(
    { 'items.handoffDoneBy': userId },
    {
      $set: {
        'items.$[item].handoffDoneBy': null,
        'items.$[item].handoffDoneAt': null,
        'items.$[item].handoffDone': false,
      },
    },
    {
      arrayFilters: [{ 'item.handoffDoneBy': userId }],
    }
  );

  // Delete user
  await User.findByIdAndDelete(req.params.id);

  res.status(200).json({
    success: true,
    message: 'User deleted successfully',
  });
});

// Assign User to Center with Role
exports.assignUserToCenter = catchAsyncErrors(async (req, res, next) => {
  const { userId, centerId, roleId } = req.body;

  if (!userId || !centerId || !roleId) {
    return next(
      new ErrorHandler(
        'Please provide userId, centerId and roleId',
        400
      )
    );
  }

  const user = await User.findById(userId);
  if (!user) {
    return next(new ErrorHandler('User not found', 404));
  }

  const center = await Center.findById(centerId);
  if (!center) {
    return next(new ErrorHandler('Center not found', 404));
  }

  const role = await Role.findById(roleId);
  if (!role) {
    return next(new ErrorHandler('Role not found', 404));
  }

  // Check if already assigned
  let userCenterRole = await UserCenterRole.findOne({
    user: userId,
    center: centerId,
  });

  if (userCenterRole) {
    userCenterRole.role = roleId;
    await userCenterRole.save();
  } else {
    userCenterRole = await UserCenterRole.create({
      user: userId,
      center: centerId,
      role: roleId,
    });
  }

  res.status(201).json({
    success: true,
    message: 'User assigned to center successfully',
    userCenterRole,
  });
});
