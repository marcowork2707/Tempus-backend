const {
  syncActiveClients,
  clearSessionCache,
  getStoredAbsences,
  getAbsenceSnapshotsRange,
  refreshAndStoreAbsences,
  getStoredOccupancy,
  refreshAndStoreOccupancy,
  refreshAndStoreOccupancyRange,
  getStoredAimHarderIntegration,
  upsertAimHarderIntegration,
  getClassReportContext,
  getClassReportStatus,
  saveClassReport,
  resetClassReportTask,
  setClassReportHandoffStatus,
  getPendingPaymentsWithTPVError,
  getPendingPaymentsWithoutTPVError,
  getTariffCancellationRenewals,
} = require('../services/aimharderService');
const UserCenterRole = require('../models/UserCenterRole');
const User = require('../models/User');
const ActiveClient = require('../models/ActiveClient');

function normalizeName(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function namesLikelyMatch(left = '', right = '') {
  const normalizedLeft = normalizeName(left);
  const normalizedRight = normalizeName(right);

  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return true;

  const leftTokens = normalizedLeft.split(' ').filter(Boolean);
  const rightTokens = normalizedRight.split(' ').filter(Boolean);
  const commonTokens = leftTokens.filter((token) => rightTokens.includes(token));

  return commonTokens.length >= Math.min(2, leftTokens.length, rightTokens.length);
}

function buildUserNameCandidates(user) {
  if (!user) return [];

  return Array.from(
    new Set(
      [
        user.name,
        user.nickname,
        [user.firstName, user.lastName].filter(Boolean).join(' '),
        user.firstName,
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );
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
 * GET /api/aimharder/active-clients-sync-status?centerId=xxx
 * Devuelve la última sincronización de clientes activos para un centro.
 */
exports.getActiveClientsSyncStatus = async (req, res) => {
  try {
    const { centerId } = req.query;
    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId es obligatorio' });
    }

    const latest = await ActiveClient.findOne({ center: centerId })
      .select('reportDate lastSyncedAt')
      .sort({ lastSyncedAt: -1, updatedAt: -1 });

    if (!latest) {
      return res.json({
        success: true,
        hasData: false,
        lastSyncAt: null,
        reportDate: null,
        count: 0,
      });
    }

    const count = await ActiveClient.countDocuments({ center: centerId, reportDate: latest.reportDate });

    return res.json({
      success: true,
      hasData: true,
      lastSyncAt: latest.lastSyncedAt || null,
      reportDate: latest.reportDate || null,
      count,
    });
  } catch (err) {
    console.error('[AimHarder Controller] Error getActiveClientsSyncStatus:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Error al obtener el estado de sincronización de clientes activos.',
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

    const currentUser = await User.findById(req.user.id).select('name nickname firstName lastName');
    const allowAllReports = includeAll === 'true';
    const result = await getClassReportContext(date || null, centerId, buildUserNameCandidates(currentUser), allowAllReports, req.user.id);

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

exports.getClassReportStatus = async (req, res) => {
  try {
    const { centerId, date, initialize } = req.query;
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

    const result = await getClassReportStatus(date || null, centerId, {
      initialize: initialize === 'true',
    });
    const currentUser = await User.findById(req.user.id).select('name nickname firstName lastName');
    const userNameCandidates = buildUserNameCandidates(currentUser);
    const personalInstructor = (result.instructors || []).find((item) =>
      userNameCandidates.some((candidate) => namesLikelyMatch(candidate, item.instructorName))
    ) || null;

    res.json({
      success: true,
      ...result,
      personalDone: personalInstructor ? !!personalInstructor.done : false,
      personalTotalClasses: personalInstructor ? Number(personalInstructor.totalClasses || personalInstructor.totalGroups || 0) : 0,
      personalCompletedClasses: personalInstructor ? Number(personalInstructor.completedClasses || personalInstructor.completedGroups || 0) : 0,
      personalInstructorName: personalInstructor?.instructorName || null,
    });
  } catch (err) {
    console.error('[AimHarder Controller] Error getClassReportStatus:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error al obtener el estado de avisos por instructor.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

exports.saveClassReport = async (req, res) => {
  try {
    const { centerId, date, period, instructorName, items, completedClasses } = req.body || {};
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

    const currentUser = await User.findById(req.user.id).select('name nickname firstName lastName');
    const userNameCandidates = buildUserNameCandidates(currentUser);
    const canSaveOwnReport = userNameCandidates.some((candidate) => namesLikelyMatch(candidate, instructorName));

    if (req.user.role !== 'admin' && !canSaveOwnReport) {
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
      completedClasses,
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

exports.resetClassReportTask = async (req, res) => {
  try {
    const { centerId, date, instructorName } = req.body || {};
    if (!centerId || !instructorName) {
      return res.status(400).json({ success: false, message: 'centerId e instructorName son obligatorios' });
    }

    const result = await resetClassReportTask({
      centerId,
      date,
      instructorName,
    });

    res.json({
      success: true,
      message: 'La tarea de avisos se ha reseteado correctamente',
      ...result,
    });
  } catch (err) {
    console.error('[AimHarder Controller] Error resetClassReportTask:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error al resetear la tarea de avisos del instructor.',
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

/**
 * GET /api/aimharder/tariff-cancellation-renewals?centerId=xxx&date=YYYY-MM-DD
 * Obtiene clientes con tarifas trimestrales/semestrales desde "Informes > Cancelaciones de tarifa".
 */
exports.getTariffCancellationRenewals = async (req, res) => {
  try {
    const { centerId, date } = req.query;
    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId es obligatorio' });
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: 'Formato de fecha inválido. Usa YYYY-MM-DD' });
    }

    const result = await getTariffCancellationRenewals(centerId, date || null);
    res.json({
      success: true,
      startDate: result.startDate,
      endDate: result.endDate,
      count: result.clients.length,
      clients: result.clients,
    });
  } catch (err) {
    console.error('[AimHarder Controller] Error cancelaciones de tarifa:', err.message);
    if (err.message.includes('credenciales')) {
      return res.status(503).json({ success: false, message: err.message });
    }
    res.status(500).json({
      success: false,
      message: 'Error al obtener cancelaciones de tarifa desde AimHarder.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

/**
 * GET /api/aimharder/occupancy-report?centerId=X&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Aggregated occupancy stats for admin reports dashboard.
 */
exports.getOccupancyReport = async (req, res) => {
  try {
    const { centerId, startDate, endDate } = req.query;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId es obligatorio' });
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'startDate y endDate son obligatorios' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ success: false, message: 'Formato de fecha inválido. Usa YYYY-MM-DD' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ success: false, message: 'startDate debe ser anterior a endDate' });
    }

    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const normalizeInstructorDisplayName = (value = '') => String(value)
      .replace(/([a-záéíóúñ])([A-ZÁÉÍÓÚÑ])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
    const instructorKey = (value = '') => normalizeInstructorDisplayName(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const [snapshots, absenceSnaps] = await Promise.all([
      getStoredOccupancy(startDate, endDate, centerId),
      getAbsenceSnapshotsRange(startDate, endDate, centerId),
    ]);

    const absenceByDate = new Map(absenceSnaps.map((s) => [s.date, s.absences.length]));

    // ── Daily aggregation ──────────────────────────────────────────────
    const daily = snapshots.map((snap) => {
      const classes = (snap.classes || []).filter((c) => c.capacity > 0);
      return {
        date: snap.date,
        avgOccupancy: Math.round(avg(classes.map((c) => c.occupancyRate))),
        avgAttendance: Math.round(avg(classes.map((c) => c.attendanceRate))),
        totalBooked: sum(classes.map((c) => c.bookedCount)),
        totalAttended: sum(classes.map((c) => c.attendanceCount)),
        totalNoShows: sum(classes.map((c) => c.noShowCount)),
        totalWaitlist: sum(classes.map((c) => c.waitlistCount)),
        classCount: classes.length,
        absenceCount: absenceByDate.get(snap.date) ?? 0,
      };
    });

    // ── Per class-name aggregation ─────────────────────────────────────
    const classMap = new Map();
    for (const snap of snapshots) {
      for (const cls of snap.classes) {
        if (!cls.className) continue;
        if (!classMap.has(cls.className)) classMap.set(cls.className, []);
        classMap.get(cls.className).push(cls);
      }
    }
    const byClass = [...classMap.entries()]
      .map(([className, records]) => {
        const valid = records.filter((r) => r.capacity > 0);
        return {
          className,
          avgOccupancy: Math.round(avg(valid.map((r) => r.occupancyRate))),
          avgAttendance: Math.round(avg(valid.map((r) => r.attendanceRate))),
          avgBooked: Math.round(avg(records.map((r) => r.bookedCount))),
          totalClasses: records.length,
        };
      })
      .sort((a, b) => b.avgOccupancy - a.avgOccupancy);

    // ── Per instructor aggregation ─────────────────────────────────────
    const instructorMap = new Map();
    for (const snap of snapshots) {
      for (const cls of snap.classes) {
        if (!cls.instructorName) continue;
        const key = instructorKey(cls.instructorName);
        if (!key) continue;
        if (!instructorMap.has(key)) {
          instructorMap.set(key, { records: [], labels: new Map() });
        }
        const bucket = instructorMap.get(key);
        const display = normalizeInstructorDisplayName(cls.instructorName);
        bucket.records.push(cls);
        bucket.labels.set(display, (bucket.labels.get(display) || 0) + 1);
      }
    }
    const byInstructor = [...instructorMap.entries()]
      .map(([, bucket]) => {
        const records = bucket.records;
        const valid = records.filter((r) => r.capacity > 0);
        const labelEntries = [...bucket.labels.entries()];
        labelEntries.sort((a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];
          return a[0].length - b[0].length;
        });
        const instructorName = labelEntries[0]?.[0] || 'Entrenador';
        return {
          instructorName,
          avgOccupancy: Math.round(avg(valid.map((r) => r.occupancyRate))),
          avgAttendance: Math.round(avg(valid.map((r) => r.attendanceRate))),
          totalClasses: records.length,
        };
      })
      .sort((a, b) => b.totalClasses - a.totalClasses);

    const rawClasses = snapshots.flatMap((snap) =>
      (snap.classes || []).map((cls) => ({
        date: snap.date,
        className: cls.className,
        classTime: cls.classTime,
        instructorName: normalizeInstructorDisplayName(cls.instructorName || ''),
        bookedCount: cls.bookedCount || 0,
        attendanceCount: cls.attendanceCount || 0,
        noShowCount: cls.noShowCount || 0,
        waitlistCount: cls.waitlistCount || 0,
        capacity: cls.capacity || 0,
        occupancyRate: cls.occupancyRate || 0,
        attendanceRate: cls.attendanceRate || 0,
      }))
    );

    // ── Per hour-slot aggregation ──────────────────────────────────────
    const hourMap = new Map();
    for (const snap of snapshots) {
      for (const cls of snap.classes) {
        const hour = cls.classTime ? cls.classTime.split(':')[0].padStart(2, '0') : '00';
        if (!hourMap.has(hour)) hourMap.set(hour, []);
        hourMap.get(hour).push(cls);
      }
    }
    const byHour = [...hourMap.entries()]
      .map(([hour, records]) => {
        const valid = records.filter((r) => r.capacity > 0);
        return {
          hour: `${hour}:00`,
          avgOccupancy: Math.round(avg(valid.map((r) => r.occupancyRate))),
          avgBooked: Math.round(avg(records.map((r) => r.bookedCount))),
          classCount: records.length,
        };
      })
      .sort((a, b) => a.hour.localeCompare(b.hour));

    // ── Overall summary KPIs ───────────────────────────────────────────
    const allValid = snapshots.flatMap((s) => s.classes).filter((c) => c.capacity > 0);
    const peakDay = daily.length ? daily.reduce((a, b) => (a.avgOccupancy >= b.avgOccupancy ? a : b)) : null;
    const worstDay = daily.length ? daily.reduce((a, b) => (a.avgOccupancy <= b.avgOccupancy ? a : b)) : null;

    const summary = {
      totalDays: snapshots.length,
      totalClasses: allValid.length,
      avgOccupancy: Math.round(avg(allValid.map((c) => c.occupancyRate))),
      avgAttendance: Math.round(avg(allValid.map((c) => c.attendanceRate))),
      totalBooked: sum(allValid.map((c) => c.bookedCount)),
      totalAttended: sum(allValid.map((c) => c.attendanceCount)),
      totalNoShows: sum(allValid.map((c) => c.noShowCount)),
      totalWaitlist: sum(allValid.map((c) => c.waitlistCount)),
      totalAbsences: absenceSnaps.reduce((acc, s) => acc + s.absences.length, 0),
      peakDay: peakDay ? { date: peakDay.date, value: peakDay.avgOccupancy } : null,
      worstDay: worstDay ? { date: worstDay.date, value: worstDay.avgOccupancy } : null,
    };

    res.json({ success: true, summary, daily, byClass, byInstructor, byHour, rawClasses });
  } catch (err) {
    console.error('[AimHarder Controller] Error getOccupancyReport:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error al generar el informe de ocupación.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};
