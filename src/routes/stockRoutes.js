const express = require('express');
const router = express.Router();
const {
  getStockConfig,
  upsertStockConfig,
  submitStockReport,
  getStockReports,
  getActiveStockAlerts,
  dismissStockAlert,
  getCenterInventory,
  getCenterInventoryMonths,
  upsertCenterInventoryStructure,
  updateCenterInventoryQuantities,
  copyPreviousCenterInventory,
} = require('../controllers/stockController');

const ALL_CENTER_ROLES = ['admin', 'encargado', 'coach', 'limpieza'];
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

// Active alerts routes (shared management)
router
  .route('/:centerId/alerts')
  .get(isAuthenticatedUser, authorizeRoles('admin', 'encargado'), getActiveStockAlerts);

router
  .route('/:centerId/alerts/:alertId')
  .delete(isAuthenticatedUser, authorizeRoles('admin', 'encargado'), dismissStockAlert);

// Inventario mensual. Lectura y cantidades: todos los roles del centro.
// Estructura (grupos/artículos) y copiar mes anterior: solo encargado/admin.
router
  .route('/:centerId/inventory')
  .get(isAuthenticatedUser, authorizeRoles(...ALL_CENTER_ROLES), getCenterInventory);

router
  .route('/:centerId/inventory/months')
  .get(isAuthenticatedUser, authorizeRoles(...ALL_CENTER_ROLES), getCenterInventoryMonths);

router
  .route('/:centerId/inventory/structure')
  .put(isAuthenticatedUser, authorizeRoles('admin', 'encargado'), upsertCenterInventoryStructure);

router
  .route('/:centerId/inventory/quantities')
  .put(isAuthenticatedUser, authorizeRoles(...ALL_CENTER_ROLES), updateCenterInventoryQuantities);

router
  .route('/:centerId/inventory/copy-previous')
  .post(isAuthenticatedUser, authorizeRoles('admin', 'encargado'), copyPreviousCenterInventory);

module.exports = router;
