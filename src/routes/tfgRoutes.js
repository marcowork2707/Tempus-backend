const express = require('express');
const router = express.Router();
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');
const {
  listChurnScores,
  getClientChurnHistory,
  getActivityMetrics,
} = require('../controllers/tfgController');

router.get('/churn-scores', isAuthenticatedUser, authorizeRoles('admin'), listChurnScores);
router.get(
  '/churn-scores/:clientHash',
  isAuthenticatedUser,
  authorizeRoles('admin'),
  getClientChurnHistory
);
router.get('/activity-metrics', isAuthenticatedUser, authorizeRoles('admin'), getActivityMetrics);

module.exports = router;
