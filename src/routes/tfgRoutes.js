const express = require('express');
const router = express.Router();
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');
const {
  listChurnScores,
  getClientChurnHistory,
  getActivityMetrics,
  getClientDetail,
  getClientActivity,
  createClientAction,
  getClientActions,
  deleteClientAction,
} = require('../controllers/tfgController');

router.get('/churn-scores', isAuthenticatedUser, authorizeRoles('admin'), listChurnScores);
router.get(
  '/churn-scores/:clientHash',
  isAuthenticatedUser,
  authorizeRoles('admin'),
  getClientChurnHistory
);
router.get('/activity-metrics', isAuthenticatedUser, authorizeRoles('admin'), getActivityMetrics);
router.get(
  '/client-detail/:clientHash',
  isAuthenticatedUser,
  authorizeRoles('admin'),
  getClientDetail
);
router.get(
  '/client-activity/:clientHash',
  isAuthenticatedUser,
  authorizeRoles('admin'),
  getClientActivity
);

router.post('/client-actions', isAuthenticatedUser, authorizeRoles('admin'), createClientAction);
router.get('/client-actions', isAuthenticatedUser, authorizeRoles('admin'), getClientActions);
router.delete(
  '/client-actions/:actionId',
  isAuthenticatedUser,
  authorizeRoles('admin'),
  deleteClientAction
);

module.exports = router;
