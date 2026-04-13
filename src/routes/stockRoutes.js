const express = require('express');
const router = express.Router();
const {
  getStockConfig,
  upsertStockConfig,
  submitStockReport,
  getStockReports,
} = require('../controllers/stockController');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');

// Config routes
router
  .route('/:centerId/config')
  .get(isAuthenticatedUser, authorizeRoles('admin'), getStockConfig)
  .put(isAuthenticatedUser, authorizeRoles('admin'), upsertStockConfig);

// Report routes
router
  .route('/:centerId/reports')
  .get(isAuthenticatedUser, authorizeRoles('admin'), getStockReports)
  .post(isAuthenticatedUser, authorizeRoles('admin'), submitStockReport);

module.exports = router;
