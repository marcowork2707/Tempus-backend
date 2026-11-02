const jwt = require('jsonwebtoken');
const ErrorHandler = require('../utils/errorHandler');
const UserCenterRole = require('../models/UserCenterRole');
const User = require('../models/User');

// Check if user is authenticated
const isAuthenticatedUser = async (req, res, next) => {
  // Try to get token from Authorization header first (for API calls)
  let token = null;
  
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7); // Remove "Bearer " prefix
  }
  
  // If no token in header, try cookies (for browser sessions)
  if (!token && req.cookies) {
    token = req.cookies.token;
  }

  if (!token) {
    return next(
      new ErrorHandler('Please Login first to access this resource', 401)
    );
  }

  try {
    const decodedData = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      id: decodedData.id,
      role: decodedData.role,
    };

    // Un trabajador dado de baja pierde el acceso aunque su sesión siga abierta
    const account = await User.findById(req.user.id).select('active').lean();
    if (!account || account.active === false) {
      return next(new ErrorHandler('Tu cuenta está dada de baja', 401));
    }

    if (!req.user.role && req.user.id) {
      const userCenterRole = await UserCenterRole.findOne({
        user: req.user.id,
        active: true,
      }).populate('role');

      if (userCenterRole?.role?.name) {
        req.user.role = userCenterRole.role.name;
      }
    }

    next();
  } catch (error) {
    return next(new ErrorHandler('Invalid token', 401));
  }
};

// Check user role permission
const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new ErrorHandler(
          `Role: ${req.user.role} is not allowed to access this resouce`,
          403
        )
      );
    }

    next();
  };
};

module.exports = {
  isAuthenticatedUser,
  authorizeRoles,
};
