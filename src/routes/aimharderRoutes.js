const express = require('express');
const router = express.Router();
const {
  getAbsences,
  getOccupancy,
  clearSession,
  syncActiveClients,
  getActiveClientsSyncStatus,
  getIntegration,
  updateIntegration,
  getClassReports,
  getClassReportStatus,
  saveClassReport,
  resetClassReportTask,
  setClassReportHandoff,
  getTpvRedsysPayments,
  getPendingPaymentsNoTpv,
  getActiveClientsReport,
  getTariffCancellationRenewals,
  setClientMonthlyMetricsManual,
  getOccupancyReport,
} = require('../controllers/aimharderController');
const { isAuthenticatedUser, authorizeRoles } = require('../middleware/auth');

// Obtener ausencias de un día (ayer por defecto)
// GET /api/aimharder/absences?date=YYYY-MM-DD
router.get('/absences', isAuthenticatedUser, getAbsences);
router.get('/occupancy', isAuthenticatedUser, getOccupancy);

// Fuerza la sincronización de clientes activos
// POST /api/aimharder/sync-active-clients
router.post('/sync-active-clients', isAuthenticatedUser, syncActiveClients);
router.get('/active-clients-sync-status', isAuthenticatedUser, getActiveClientsSyncStatus);

// Limpiar caché de sesión de AimHarder
// POST /api/aimharder/clear-session
router.post('/clear-session', isAuthenticatedUser, clearSession);
router.get('/integration/:centerId', isAuthenticatedUser, authorizeRoles('admin'), getIntegration);
router.put('/integration/:centerId', isAuthenticatedUser, authorizeRoles('admin'), updateIntegration);
router.get('/class-reports', isAuthenticatedUser, getClassReports);
router.get('/class-reports/status', isAuthenticatedUser, getClassReportStatus);
router.put('/class-reports', isAuthenticatedUser, saveClassReport);
router.post('/class-reports/reset', isAuthenticatedUser, authorizeRoles('admin'), resetClassReportTask);
router.put('/class-reports/handoff', isAuthenticatedUser, setClassReportHandoff);
router.get('/tpv-redsys-payments', isAuthenticatedUser, getTpvRedsysPayments);
router.get('/pending-payments-no-tpv', isAuthenticatedUser, getPendingPaymentsNoTpv);
router.get('/active-clients-report', isAuthenticatedUser, getActiveClientsReport);
router.get('/tariff-cancellation-renewals', isAuthenticatedUser, getTariffCancellationRenewals);
router.put('/monthly-metrics-manual', isAuthenticatedUser, setClientMonthlyMetricsManual);
router.get('/occupancy-report', isAuthenticatedUser, authorizeRoles('admin'), getOccupancyReport);

module.exports = router;
