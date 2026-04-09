const express = require('express');
const router = express.Router();

const {
  registerUser,
  loginUser,
  activateAccount,
  logoutUser,
  getUserCenters,
  getUserDetail,
} = require('../controllers/authController');

const { isAuthenticatedUser } = require('../middleware/auth');

// Public routes
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/activate-account', activateAccount);

// Protected routes
router.get('/me', isAuthenticatedUser, getUserDetail);
router.get('/centers', isAuthenticatedUser, getUserCenters);
router.post('/logout', isAuthenticatedUser, logoutUser);

module.exports = router;
