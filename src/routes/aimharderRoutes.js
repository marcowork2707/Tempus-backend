const express = require('express');
const router = express.Router();
const {
  getAbsences,
  getOccupancy,
  clearSession,
  syncActiveClients,
  getIntegration,
  updateIntegration,
  getClassReports,
  saveClassReport,
  setClassReportHandoff,
  getTpvRedsysPayments,
} = require('../controllers/aimharderController');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');

// Obtener ausencias de un día (ayer por defecto)
// GET /api/aimharder/absences?date=YYYY-MM-DD
router.get('/absences', isAuthenticatedUser, getAbsences);
router.get('/occupancy', isAuthenticatedUser, getOccupancy);

// Fuerza la sincronización de clientes activos
// POST /api/aimharder/sync-active-clients
router.post('/sync-active-clients', isAuthenticatedUser, syncActiveClients);

// Limpiar caché de sesión de AimHarder
// POST /api/aimharder/clear-session
router.post('/clear-session', isAuthenticatedUser, clearSession);
router.get('/integration/:centerId', isAuthenticatedUser, authorizeRoles('admin'), getIntegration);
router.put('/integration/:centerId', isAuthenticatedUser, authorizeRoles('admin'), updateIntegration);
router.get('/class-reports', isAuthenticatedUser, getClassReports);
router.put('/class-reports', isAuthenticatedUser, saveClassReport);
router.put('/class-reports/handoff', isAuthenticatedUser, setClassReportHandoff);
router.get('/tpv-redsys-payments', isAuthenticatedUser, getTpvRedsysPayments);

module.exports = router;
