const express = require('express');
const multer = require('multer');
const router = express.Router();
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');
const {
  listChurnScores,
  getClientChurnHistory,
  getActivityMetrics,
  getSurvivalCurves,
  getClientDetail,
  getClientActivity,
  createClientAction,
  getClientActions,
  deleteClientAction,
  getExecutiveKpis,
  getModelInfo,
  importJobsCreate,
  importJobsGet,
  importJobsList,
  getDataCoverage,
} = require('../controllers/tfgController');

// Multer con memoryStorage: los buffers se pasan al microservicio Python sin tocar disco local.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB por archivo
});

router.get('/churn-scores', isAuthenticatedUser, authorizeRoles('admin'), listChurnScores);
router.get(
  '/churn-scores/:clientHash',
  isAuthenticatedUser,
  authorizeRoles('admin'),
  getClientChurnHistory
);
router.get('/activity-metrics', isAuthenticatedUser, authorizeRoles('admin'), getActivityMetrics);
router.get('/survival-curves', isAuthenticatedUser, authorizeRoles('admin'), getSurvivalCurves);
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

router.get('/executive-kpis', isAuthenticatedUser, authorizeRoles('admin'), getExecutiveKpis);
router.get('/model-info', isAuthenticatedUser, authorizeRoles('admin'), getModelInfo);

// Import jobs — proxy al microservicio Python
router.post('/import-jobs', isAuthenticatedUser, authorizeRoles('admin'), upload.array('files', 10), importJobsCreate);
router.get('/import-jobs', isAuthenticatedUser, authorizeRoles('admin'), importJobsList);
router.get('/import-jobs/:jobId', isAuthenticatedUser, authorizeRoles('admin'), importJobsGet);

router.get('/data-coverage', isAuthenticatedUser, authorizeRoles('admin'), getDataCoverage);

module.exports = router;
