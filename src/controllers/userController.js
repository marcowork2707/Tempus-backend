const User = require('../models/User');
const Center = require('../models/Center');
const UserCenterRole = require('../models/UserCenterRole');
const Role = require('../models/Role');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');
const { createInvitation } = require('./authController');
const { sendInvitationEmail } = require('../utils/email');

// Get All Users (Admin only)
exports.getAllUsers = catchAsyncErrors(async (req, res, next) => {
  const users = await User.find();

  res.status(200).json({
    success: true,
    count: users.length,
    users,
  });
});

// Get User by ID
exports.getUserById = catchAsyncErrors(async (req, res, next) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(new ErrorHandler('User not found', 404));
  }

  // Get user's centers and roles
  const userCenterRoles = await UserCenterRole.find({ user: user._id })
    .populate('center')
    .populate('role');

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
  const invitation = isInvitedUser ? createInvitation() : null;

  user = await User.create({
    firstName,
    lastName,
    name: name || `${firstName} ${lastName}`,
    email: email.toLowerCase().trim(),
    password: password || invitation.rawToken,
    dni: dni.toUpperCase().trim(),
    mustSetPassword: isInvitedUser,
    invitationStatus: isInvitedUser ? 'pending' : 'active',
    activationToken: invitation?.hashedToken || null,
    activationTokenExpires: invitation?.expiresAt || null,
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

  let invitationEmail = null;
  if (invitation && assignedCenters.length > 0) {
    const primaryAssignment = assignedCenters[0];
    const roleLabelByName = {
      coach: 'coach',
      encargado: 'encargado',
      admin: 'administrador',
    };

    invitationEmail = await sendInvitationEmail({
      to: user.email,
      firstName: user.firstName,
      centerName: primaryAssignment.centerName,
      roleLabel: roleLabelByName[primaryAssignment.roleName] || primaryAssignment.roleName,
      activationLink: invitation.activationLink,
      expiresAt: invitation.expiresAt,
    });
  }

  res.status(201).json({
    success: true,
    message: invitation
      ? invitationEmail?.sent
        ? 'Invitación enviada correctamente'
        : 'Usuario invitado creado. No se pudo enviar el email automáticamente'
      : 'User created successfully',
    user,
    invitation: invitation
      ? {
          activationLink: invitation.activationLink,
          expiresAt: invitation.expiresAt,
          emailSent: Boolean(invitationEmail?.sent),
          emailError: invitationEmail?.reason || null,
        }
      : null,
  });
});

// Update User (Admin only)
exports.updateUser = catchAsyncErrors(async (req, res, next) => {
  const { name, email, active } = req.body;

  let user = await User.findById(req.params.id);

  if (!user) {
    return next(new ErrorHandler('User not found', 404));
  }

  if (name) user.name = name;
  if (email) user.email = email;
  if (active !== undefined) user.active = active;

  await user.save();

  res.status(200).json({
    success: true,
    message: 'User updated successfully',
    user,
  });
});

// Delete User (Admin only)
exports.deleteUser = catchAsyncErrors(async (req, res, next) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(new ErrorHandler('User not found', 404));
  }

  // Delete user center roles
  await UserCenterRole.deleteMany({ user: user._id });

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
