const express = require('express');
const router = express.Router();

const {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  assignUserToCenter,
  resendInvitation,
} = require('../controllers/userController');

const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');

// All routes require admin role
router.use(isAuthenticatedUser);

// Get all users
router.get('/', authorizeRoles('admin'), getAllUsers);

// Get user by ID
router.get('/:id', authorizeRoles('admin'), getUserById);

// Create user
router.post('/', authorizeRoles('admin'), createUser);

// Update user
router.put('/:id', authorizeRoles('admin'), updateUser);

// Resend invitation / reset password by invitation
router.post('/:id/resend-invitation', authorizeRoles('admin'), resendInvitation);

// Delete user
router.delete('/:id', authorizeRoles('admin'), deleteUser);

// Assign user to center
router.post('/assign-center', authorizeRoles('admin'), assignUserToCenter);

module.exports = router;
