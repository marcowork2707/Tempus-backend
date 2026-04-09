const User = require('../models/User');
const UserCenterRole = require('../models/UserCenterRole');
const Center = require('../models/Center');
const Role = require('../models/Role');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const generateToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRY,
  });
};

const hashActivationToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const buildActivationLink = (token) => {
  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  return `${baseUrl}/auth/activar-cuenta?token=${token}`;
};

exports.registerUser = catchAsyncErrors(async (req, res, next) => {
  return next(
    new ErrorHandler(
      'El registro público está desactivado. Las cuentas solo pueden ser creadas por un administrador mediante invitación.',
      403
    )
  );
});

exports.loginUser = catchAsyncErrors(async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return next(new ErrorHandler('Please provide email and password', 400));
  }

  const user = await User.findOne({ email }).select('+password');
  if (!user) {
    return next(new ErrorHandler('Invalid email or password', 401));
  }

  const isPasswordMatched = await user.matchPassword(password);
  if (!isPasswordMatched) {
    return next(new ErrorHandler('Invalid email or password', 401));
  }

  if (user.invitationStatus === 'pending' || user.mustSetPassword) {
    return next(
      new ErrorHandler(
        'Tu cuenta está pendiente de activación. Debes crear tu contraseña desde el enlace de invitación.',
        403
      )
    );
  }

  const userCenterRole = await UserCenterRole.findOne({ user: user._id }).populate('role');
  const userRole = userCenterRole?.role?.name || 'coach';

  const token = generateToken(user._id, userRole);

  res.status(200).json({
    success: true,
    message: 'Logged in successfully',
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: userRole,
    },
    token,
  });
});

exports.activateAccount = catchAsyncErrors(async (req, res, next) => {
  const { token, password, confirmPassword } = req.body;

  if (!token || !password || !confirmPassword) {
    return next(new ErrorHandler('Token, password and confirmPassword are required', 400));
  }

  if (password.length < 6) {
    return next(new ErrorHandler('Password should be greater than 6 characters', 400));
  }

  if (password !== confirmPassword) {
    return next(new ErrorHandler('Passwords do not match', 400));
  }

  const hashedToken = hashActivationToken(token);
  const user = await User.findOne({
    activationToken: hashedToken,
    activationTokenExpires: { $gt: new Date() },
  }).select('+activationToken +activationTokenExpires +password');

  if (!user) {
    return next(new ErrorHandler('Invitation token is invalid or has expired', 400));
  }

  user.password = password;
  user.mustSetPassword = false;
  user.invitationStatus = 'active';
  user.activationToken = null;
  user.activationTokenExpires = null;

  await user.save();

  const userCenterRole = await UserCenterRole.findOne({ user: user._id }).populate('role');
  const userRole = userCenterRole?.role?.name || 'coach';
  const authToken = generateToken(user._id, userRole);

  res.status(200).json({
    success: true,
    message: 'Cuenta activada correctamente',
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: userRole,
    },
    token: authToken,
  });
});

exports.getUserCenters = catchAsyncErrors(async (req, res, next) => {
  const userId = req.user.id;

  const userCenterRoles = await UserCenterRole.find({ user: userId })
    .populate('center')
    .populate('role');

  if (!userCenterRoles) {
    return next(new ErrorHandler('No centers found for this user', 404));
  }

  const centers = userCenterRoles.map((ucr) => ({
    centerId: ucr.center._id,
    centerName: ucr.center.name,
    centerType: ucr.center.type,
    role: ucr.role.name,
    roleId: ucr.role._id,
  }));

  res.status(200).json({
    success: true,
    centers,
  });
});

exports.getUserDetail = catchAsyncErrors(async (req, res, next) => {
  const user = await User.findById(req.user.id);

  res.status(200).json({
    success: true,
    user,
  });
});

exports.logoutUser = catchAsyncErrors(async (req, res, next) => {
  res.status(200).json({
    success: true,
    message: 'Logged out successfully',
  });
});

exports.createInvitation = (expiresInDays = 30) => {
  const rawToken = crypto.randomBytes(32).toString('hex');

  return {
    rawToken,
    hashedToken: hashActivationToken(rawToken),
    expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
    activationLink: buildActivationLink(rawToken),
  };
};
