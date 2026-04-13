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
  .get(isAuthenticatedUser, authorizeRoles('admin', 'encargado', 'coach'), getStockConfig)
  .put(isAuthenticatedUser, authorizeRoles('admin'), upsertStockConfig);

// Report routes
router
  .route('/:centerId/reports')
  .get(isAuthenticatedUser, authorizeRoles('admin', 'encargado', 'coach'), getStockReports)
  .post(isAuthenticatedUser, authorizeRoles('admin', 'encargado', 'coach'), submitStockReport);

module.exports = router;
