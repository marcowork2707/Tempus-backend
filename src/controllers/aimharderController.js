const {
  syncActiveClients,
  clearSessionCache,
  getStoredAbsences,
  refreshAndStoreAbsences,
  getStoredOccupancy,
  refreshAndStoreOccupancy,
  refreshAndStoreOccupancyRange,
  getStoredAimHarderIntegration,
  upsertAimHarderIntegration,
  getClassReportContext,
  saveClassReport,
  setClassReportHandoffStatus,
  getPendingPaymentsWithTPVError,
  getPendingPaymentsWithoutTPVError,
} = require('../services/aimharderService');
const UserCenterRole = require('../models/UserCenterRole');
const User = require('../models/User');

function normalizeName(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * GET /api/aimharder/absences?date=YYYY-MM-DD
 * Si no se pasa date, devuelve las ausencias de ayer.
 */
exports.getAbsences = async (req, res) => {
  try {
    const { date, refresh, centerId } = req.query;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId es obligatorio' });
    }

    // Validación básica de formato de fecha
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: 'Formato de fecha inválido. Usa YYYY-MM-DD' });
    }

    const shouldRefresh = refresh === 'true';
    const targetDate = date || null;
    const absences = shouldRefresh
      ? await refreshAndStoreAbsences(targetDate, centerId)
      : await getStoredAbsences(targetDate, centerId);

    res.json({
      success: true,
      date: targetDate,
      count: absences.length,
      absences,
    });
  } catch (err) {
    console.error('[AimHarder Controller] Error:', err.message);

    // Si el error es de credenciales, dar mensaje claro
    if (err.message.includes('credenciales')) {
      return res.status(503).json({
        success: false,
        message: err.message,
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error al obtener ausencias de AimHarder. Revisa los logs del servidor.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

/**
 * GET /api/aimharder/occupancy?date=YYYY-MM-DD
 * GET /api/aimharder/occupancy?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
exports.getOccupancy = async (req, res) => {
  try {
    const { date, startDate, endDate, refresh, centerId } = req.query;
    const validDate = (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId es obligatorio' });
    }

    if (!validDate(date) || !validDate(startDate) || !validDate(endDate)) {
      return res.status(400).json({ success: false, message: 'Formato de fecha inválido. Usa YYYY-MM-DD' });
    }

    if ((startDate && !endDate) || (!startDate && endDate)) {
      return res.status(400).json({ success: false, message: 'Debes enviar startDate y endDate juntos' });
    }

    const shouldRefresh = refresh === 'true';
    let snapshots;

    if (shouldRefresh) {
      if (startDate && endDate) {
        snapshots = await refreshAndStoreOccupancyRange(startDate, endDate, centerId);
      } else {
        const refreshed = await refreshAndStoreOccupancy(date || null, centerId);
        snapshots = [{ date: refreshed.date, classes: refreshed.classes }];
      }
    } else {
      snapshots = await getStoredOccupancy(startDate || date || null, endDate || null, centerId);
    }

    res.json({
      success: true,
      count: snapshots.length,
      snapshots,
    });
  } catch (err) {
    console.error('[AimHarder Controller] Error getOccupancy:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error al obtener la ocupación desde AimHarder.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

/**
 * POST /api/aimharder/clear-session
 * Limpia la caché de sesión (útil si el login ha caducado)
 */
exports.clearSession = (req, res) => {
  clearSessionCache();
  res.json({ success: true, message: 'Caché de sesión eliminada' });
};

/**
 * POST /api/aimharder/sync-active-clients
 * Fuerza la sincronización de clientes activos desde AimHarder.
 */
exports.syncActiveClients = async (req, res) => {
  try {
    const { date, centerId } = req.body || {};
    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId es obligatorio' });
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: 'Formato de fecha inválido. Usa YYYY-MM-DD' });
    }

    const result = await syncActiveClients(date || null, centerId);
    res.json({
      success: true,
      message: 'Clientes activos sincronizados correctamente',
      ...result,
    });
  } catch (err) {
    console.error('[AimHarder Controller] Error syncActiveClients:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error al sincronizar clientes activos desde AimHarder.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

/**
 * GET /api/aimharder/integration/:centerId
 * Lee la integración persistida para un centro.
 */
exports.getIntegration = async (req, res) => {
  try {
    const integration = await getStoredAimHarderIntegration(req.params.centerId);
    res.json({ success: true, integration });
  } catch (err) {
    console.error('[AimHarder Controller] Error getIntegration:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error al obtener la integración de AimHarder.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

/**
 * PUT /api/aimharder/integration/:centerId
 * Guarda la integración persistida para un centro.
 */
exports.updateIntegration = async (req, res) => {
  try {
    const integration = await upsertAimHarderIntegration(req.params.centerId, req.body || {});
    res.json({
      success: true,
      message: 'Integración de AimHarder actualizada correctamente',
      integration,
    });
  } catch (err) {
    console.error('[AimHarder Controller] Error updateIntegration:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar la integración de AimHarder.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

exports.getClassReports = async (req, res) => {
  try {
    const { centerId, date, includeAll } = req.query;
    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId es obligatorio' });
    }

    if (req.user.role !== 'admin') {
      const assignment = await UserCenterRole.findOne({
        user: req.user.id,
        center: centerId,
        active: true,
      });

      if (!assignment) {
        return res.status(403).json({ success: false, message: 'No tienes acceso a este centro' });
      }
    }

    const currentUser = await User.findById(req.user.id).select('name');
    const allowAllReports = req.user.role === 'admin' || includeAll === 'true';
    const result = await getClassReportContext(date || null, centerId, currentUser?.name || '', allowAllReports, req.user.id);

    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error('[AimHarder Controller] Error getClassReports:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error al obtener los reportes de clases de AimHarder.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

exports.saveClassReport = async (req, res) => {
  try {
    const { centerId, date, period, instructorName, items } = req.body || {};
    if (!centerId || !period || !instructorName) {
      return res.status(400).json({ success: false, message: 'centerId, period e instructorName son obligatorios' });
    }

    if (req.user.role !== 'admin') {
      const assignment = await UserCenterRole.findOne({
        user: req.user.id,
        center: centerId,
        active: true,
      });

      if (!assignment) {
        return res.status(403).json({ success: false, message: 'No tienes acceso a este centro' });
      }
    }

    const currentUser = await User.findById(req.user.id).select('name');
    if (req.user.role !== 'admin' && currentUser?.name && normalizeName(currentUser.name) !== normalizeName(instructorName)) {
      return res.status(403).json({ success: false, message: 'Solo puedes guardar avisos de tus propias clases' });
    }

    const report = await saveClassReport({
      centerId,
      date,
      period,
      instructorName,
      instructorUserId: req.user.id,
      updatedBy: req.user.id,
      items,
    });

    res.json({
      success: true,
      message: 'Avisos guardados correctamente',
      report,
    });
  } catch (err) {
    console.error('[AimHarder Controller] Error saveClassReport:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error al guardar los avisos de las clases.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

exports.setClassReportHandoff = async (req, res) => {
  try {
    const { centerId, date, period, instructorName, className, classTime, memberName, done } = req.body || {};
    if (!centerId || !period || !instructorName || !className || !classTime || !memberName || typeof done !== 'boolean') {
      return res.status(400).json({ success: false, message: 'centerId, period, instructorName, className, classTime, memberName y done son obligatorios' });
    }

    if (req.user.role !== 'admin') {
      const assignment = await UserCenterRole.findOne({
        user: req.user.id,
        center: centerId,
        active: true,
      });

      if (!assignment) {
        return res.status(403).json({ success: false, message: 'No tienes acceso a este centro' });
      }
    }

    const report = await setClassReportHandoffStatus({
      centerId,
      date,
      period,
      instructorName,
      className,
      classTime,
      memberName,
      done,
      updatedBy: req.user.id,
    });

    if (!report) {
      return res.status(404).json({ success: false, message: 'No se encontró el reporte a marcar' });
    }

    res.json({
      success: true,
      message: done ? 'Reporte marcado como pasado a AimHarder' : 'Reporte desmarcado',
      report,
    });
  } catch (err) {
    console.error('[AimHarder Controller] Error setClassReportHandoff:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error al marcar el reporte como pasado a AimHarder.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

/**
 * GET /api/aimharder/tpv-redsys-payments?centerId=xxx
 * Devuelve los pagos pendientes de AimHarder con fallo TPV Redsys.
 */
exports.getTpvRedsysPayments = async (req, res) => {
  try {
    const { centerId } = req.query;
    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId es obligatorio' });
    }

    const payments = await getPendingPaymentsWithTPVError(centerId);
    res.json({ success: true, count: payments.length, payments });
  } catch (err) {
    console.error('[AimHarder Controller] Error TPV Redsys:', err.message);
    if (err.message.includes('credenciales')) {
      return res.status(503).json({ success: false, message: err.message });
    }
    res.status(500).json({
      success: false,
      message: 'Error al obtener los pagos con fallo TPV de AimHarder.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

/**
 * GET /api/aimharder/pending-payments-no-tpv?centerId=xxx
 * Devuelve los pagos pendientes de AimHarder sin fallo TPV.
 */
exports.getPendingPaymentsNoTpv = async (req, res) => {
  try {
    const { centerId } = req.query;
    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId es obligatorio' });
    }

    const payments = await getPendingPaymentsWithoutTPVError(centerId);
    res.json({ success: true, count: payments.length, payments });
  } catch (err) {
    console.error('[AimHarder Controller] Error pagos pendientes sin TPV:', err.message);
    if (err.message.includes('credenciales')) {
      return res.status(503).json({ success: false, message: err.message });
    }
    res.status(500).json({
      success: false,
      message: 'Error al obtener los pagos pendientes sin fallo TPV de AimHarder.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};
