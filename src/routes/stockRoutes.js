const express = require('express');
const router = express.Router();
const {
  getStockConfig,
  upsertStockConfig,
  submitStockReport,
  getStockReports,
} = require('../controllers/stockController');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');

// Config routes (admin/encargado only)
router
  .route('/:centerId/config')
  .get(isAuthenticatedUser, authorizeRoles('admin', 'encargado'), getStockConfig)
  .put(isAuthenticatedUser, authorizeRoles('admin', 'encargado'), upsertStockConfig);

// Report routes
router
  .route('/:centerId/reports')
  .get(isAuthenticatedUser, authorizeRoles('admin', 'encargado'), getStockReports)
  .post(isAuthenticatedUser, submitStockReport);

module.exports = router;
