const mongoose = require('mongoose');
const TfgChurnScore = require('../models/tfg/TfgChurnScore');
const TfgAttendanceEvent = require('../models/tfg/TfgAttendanceEvent');
const TfgActivityMetric = require('../models/tfg/TfgActivityMetric');
const TfgClientActivity = require('../models/tfg/TfgClientActivity');
const TfgClientAction = require('../models/tfg/TfgClientAction');
const Center = require('../models/Center');

// ---------------------------------------------------------------------------
// GET /api/tfg/churn-scores?centerId=...&cutoffDate=YYYY-MM-DD&riskBand=...&limit=100&skip=0
// Lista de scores ordenada por riesgo descendente para el panel "Riesgo de abandono".
// ---------------------------------------------------------------------------
exports.listChurnScores = async (req, res) => {
  try {
    const { centerId, cutoffDate, riskBand } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const skip = parseInt(req.query.skip, 10) || 0;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId requerido' });
    }

    if (!mongoose.Types.ObjectId.isValid(centerId)) {
      return res.status(400).json({ success: false, message: 'centerId no es un ObjectId valido' });
    }

    const filter = { center: new mongoose.Types.ObjectId(centerId) };

    // Si no se pasa cutoffDate, usar la ultima fecha disponible para este centro
    let resolvedCutoffDate = cutoffDate ? new Date(cutoffDate) : null;
    if (!resolvedCutoffDate) {
      const latest = await TfgChurnScore.findOne(filter)
        .sort({ cutoffDate: -1 })
        .select('cutoffDate')
        .lean();
      if (latest) {
        resolvedCutoffDate = latest.cutoffDate;
      }
    }

    if (resolvedCutoffDate) {
      filter.cutoffDate = resolvedCutoffDate;
    }

    if (riskBand) filter.riskBand = riskBand;

    // bandCounts globales: independientes del filtro de riskBand y paginacion
    const bandCountsFilter = {
      center: new mongoose.Types.ObjectId(centerId),
    };
    if (resolvedCutoffDate) bandCountsFilter.cutoffDate = resolvedCutoffDate;

    const [scores, total, bandAgg] = await Promise.all([
      TfgChurnScore.find(filter)
        .sort({ score: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      TfgChurnScore.countDocuments(filter),
      TfgChurnScore.aggregate([
        { $match: bandCountsFilter },
        { $group: { _id: '$riskBand', count: { $sum: 1 } } },
      ]),
    ]);

    const bandCounts = { high: 0, medium: 0, low: 0, total: 0 };
    bandAgg.forEach(({ _id, count }) => {
      if (_id in bandCounts) bandCounts[_id] = count;
      bandCounts.total += count;
    });

    // Adjuntar nombre legible del centro
    let centerName = null;
    try {
      const centerDoc = await Center.findById(centerId).select('name').lean();
      if (centerDoc) centerName = centerDoc.name;
    } catch (_) {}

    return res.json({
      success: true,
      data: scores,
      meta: {
        total,
        limit,
        skip,
        cutoffDate: resolvedCutoffDate ? resolvedCutoffDate.toISOString().slice(0, 10) : null,
        centerName,
        bandCounts,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/tfg/churn-scores/:clientHash?centerId=...
// Historico de scores de un cliente concreto (para drill-down).
// ---------------------------------------------------------------------------
exports.getClientChurnHistory = async (req, res) => {
  try {
    const { clientHash } = req.params;
    const { centerId } = req.query;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId requerido' });
    }
    if (!mongoose.Types.ObjectId.isValid(centerId)) {
      return res.status(400).json({ success: false, message: 'centerId no es un ObjectId valido' });
    }

    const history = await TfgChurnScore.find({
      center: new mongoose.Types.ObjectId(centerId),
      clientHash,
    })
      .sort({ cutoffDate: -1 })
      .limit(52) // maximo 1 año de cortes semanales / 12 cortes mensuales
      .lean();

    return res.json({ success: true, data: history });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/tfg/activity-metrics?centerId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
// Metricas agregadas de actividad del centro.
// ---------------------------------------------------------------------------
exports.getActivityMetrics = async (req, res) => {
  try {
    const { centerId, from, to, rangeKey } = req.query;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId requerido' });
    }
    if (!mongoose.Types.ObjectId.isValid(centerId)) {
      return res.status(400).json({ success: false, message: 'centerId no es un ObjectId valido' });
    }

    const centerOid = new mongoose.Types.ObjectId(centerId);
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const resolvedRangeKey = rangeKey || '1m';

    // Comprobar si hay eventos de asistencia en Mongo
    const eventCount = await TfgAttendanceEvent.countDocuments({ center: centerOid });
    const hasEventData = eventCount > 0;

    // --- Distribucion de riesgo desde tfgchurnscores (siempre disponible si se corrio el batch) ---
    const latestCutoff = await TfgChurnScore.findOne({ center: centerOid })
      .sort({ cutoffDate: -1 })
      .select('cutoffDate')
      .lean();

    let riskDistribution = { low: 0, medium: 0, high: 0, total: 0, cutoffDate: null };
    if (latestCutoff) {
      const riskAgg = await TfgChurnScore.aggregate([
        { $match: { center: centerOid, cutoffDate: latestCutoff.cutoffDate } },
        { $group: { _id: '$riskBand', count: { $sum: 1 } } },
      ]);
      riskAgg.forEach(({ _id, count }) => {
        if (_id in riskDistribution) riskDistribution[_id] = count;
        riskDistribution.total += count;
      });
      riskDistribution.cutoffDate = latestCutoff.cutoffDate.toISOString().slice(0, 10);
    }

    const highRiskPct =
      riskDistribution.total > 0
        ? parseFloat(((riskDistribution.high / riskDistribution.total) * 100).toFixed(1))
        : null;

    if (!hasEventData) {
      // Fallback: leer metricas precomputadas por el batch en tfgactivitymetrics
      const precomputed = await TfgActivityMetric.findOne({
        center: centerOid,
        rangeKey: resolvedRangeKey,
      })
        .sort({ cutoffDate: -1 })
        .lean();

      if (precomputed) {
        return res.json({
          success: true,
          dataSource: 'precomputed_batch',
          weeklyAttendance: precomputed.weeklyAttendance || [],
          noShowRate: precomputed.noShowRate,
          topClasses: precomputed.topClasses || [],
          totalAttendances: precomputed.totalAttendances || 0,
          riskDistribution,
          highRiskPct,
        });
      }

      return res.json({
        success: true,
        dataSource: 'churn_scores_only',
        message: 'Sin datos de eventos ingestados todavia. Metricas de asistencia no disponibles. Solo se devuelve la distribucion de riesgo desde tfgchurnscores.',
        riskDistribution,
        highRiskPct,
        weeklyAttendance: [],
        noShowRate: null,
        topClasses: [],
      });
    }

    // --- Asistencias semanales ---
    const weeklyAgg = await TfgAttendanceEvent.aggregate([
      {
        $match: {
          center: centerOid,
          classDateTime: { $gte: fromDate, $lte: toDate },
          reservationStatus: 'attended',
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: { $dateTrunc: { date: '$classDateTime', unit: 'week' } },
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const weeklyAttendance = weeklyAgg.map((w) => ({ weekStart: w._id, count: w.count }));

    // --- Tasa de no-shows ---
    const [totalReservations, totalNoShows] = await Promise.all([
      TfgAttendanceEvent.countDocuments({
        center: centerOid,
        classDateTime: { $gte: fromDate, $lte: toDate },
        reservationStatus: { $in: ['attended', 'no_show'] },
      }),
      TfgAttendanceEvent.countDocuments({
        center: centerOid,
        classDateTime: { $gte: fromDate, $lte: toDate },
        reservationStatus: 'no_show',
      }),
    ]);
    const noShowRate = totalReservations > 0
      ? parseFloat(((totalNoShows / totalReservations) * 100).toFixed(1))
      : null;

    // --- Top-5 clases por volumen ---
    const topClassesAgg = await TfgAttendanceEvent.aggregate([
      {
        $match: {
          center: centerOid,
          classDateTime: { $gte: fromDate, $lte: toDate },
          reservationStatus: 'attended',
          classType: { $nin: ['', null] },
        },
      },
      { $group: { _id: '$classType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]);
    const topClasses = topClassesAgg.map((c) => ({ classType: c._id, count: c.count }));

    return res.json({
      success: true,
      dataSource: 'attendance_events',
      weeklyAttendance,
      noShowRate,
      topClasses,
      riskDistribution,
      highRiskPct,
      totalAttendances: weeklyAttendance.reduce((s, w) => s + w.count, 0),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/tfg/client-detail/:clientHash?centerId=...
// Vista detalle de un cliente: score actual + histórico de scores.
// ---------------------------------------------------------------------------
exports.getClientDetail = async (req, res) => {
  try {
    const { clientHash } = req.params;
    const { centerId } = req.query;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId requerido' });
    }
    if (!mongoose.Types.ObjectId.isValid(centerId)) {
      return res.status(400).json({ success: false, message: 'centerId no es un ObjectId valido' });
    }

    const centerOid = new mongoose.Types.ObjectId(centerId);

    // Histórico de scores ordenado desc (el primero es el más reciente)
    const history = await TfgChurnScore.find({
      center: centerOid,
      clientHash,
    })
      .sort({ cutoffDate: -1 })
      .limit(52)
      .lean();

    if (history.length === 0) {
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }

    const current = history[0];

    const scoreHistory = history.map((h) => ({
      cutoffDate: h.cutoffDate.toISOString().slice(0, 10),
      score: h.score,
      riskBand: h.riskBand,
    }));

    return res.json({
      success: true,
      data: {
        clientHash: current.clientHash,
        clientName: current.clientName || '',
        phone: current.phone || '',
        aimharderId: current.aimharderId || '',
        tarifa: current.tarifa || '',
        cohortType: current.cohortType || 'regular',
        currentScore: {
          score: current.score,
          riskBand: current.riskBand,
          cutoffDate: current.cutoffDate.toISOString().slice(0, 10),
          horizonDays: current.horizonDays,
          modelVersion: current.modelVersion,
          baselineScore: current.baselineScore ?? null,
          topFeatures: current.topFeatures || [],
        },
        scoreHistory,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/tfg/client-activity/:clientHash?centerId=...&days=365
// Actividad del cliente: asistencias (heatmap), no-shows, pagos, cambios tarifa.
// Lee de la colección tfgclientactivity escrita por el batch Python.
// ---------------------------------------------------------------------------
exports.getClientActivity = async (req, res) => {
  try {
    const { clientHash } = req.params;
    const { centerId } = req.query;
    const days = Math.min(parseInt(req.query.days, 10) || 365, 730);

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId requerido' });
    }
    if (!mongoose.Types.ObjectId.isValid(centerId)) {
      return res.status(400).json({ success: false, message: 'centerId no es un ObjectId valido' });
    }

    const centerOid = new mongoose.Types.ObjectId(centerId);

    const doc = await TfgClientActivity.findOne({
      center: centerOid,
      clientHash,
    }).lean();

    if (!doc) {
      // Devolver estructura vacía si aún no se ha poblado la colección
      return res.json({
        success: true,
        dataSource: 'empty',
        message: 'Sin datos de actividad. Ejecuta el batch con soporte client-activity.',
        data: {
          attendances: [],
          noShows: [],
          payments: [],
          tarifaChanges: [],
        },
      });
    }

    // Filtrar por ventana temporal solicitada
    const cutoff = new Date();
    const fromDate = new Date(cutoff.getTime() - days * 24 * 60 * 60 * 1000);
    const fromStr = fromDate.toISOString().slice(0, 10);

    const filterByDate = (items) =>
      (items || []).filter((item) => item.date >= fromStr);

    return res.json({
      success: true,
      dataSource: 'mongo',
      data: {
        attendances: filterByDate(doc.attendances),
        noShows: filterByDate(doc.noShows),
        payments: filterByDate(doc.payments),
        tarifaChanges: filterByDate(doc.tarifaChanges),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// POST /api/tfg/client-actions
// Registra una accion sobre un cliente (contacted / snoozed / false_positive).
// Body: { centerId, clientHash, action, notes?, snoozeUntil? }
// ---------------------------------------------------------------------------
exports.createClientAction = async (req, res) => {
  try {
    const { centerId, clientHash, action, notes, snoozeUntil } = req.body;

    if (!centerId || !clientHash || !action) {
      return res.status(400).json({ success: false, message: 'centerId, clientHash y action son requeridos' });
    }
    if (!mongoose.Types.ObjectId.isValid(centerId)) {
      return res.status(400).json({ success: false, message: 'centerId no es un ObjectId valido' });
    }
    if (!['contacted', 'snoozed', 'false_positive'].includes(action)) {
      return res.status(400).json({ success: false, message: 'action debe ser contacted, snoozed o false_positive' });
    }
    if (action === 'snoozed' && !snoozeUntil) {
      return res.status(400).json({ success: false, message: 'snoozeUntil es requerido para action=snoozed' });
    }

    const doc = await TfgClientAction.create({
      center: new mongoose.Types.ObjectId(centerId),
      clientHash,
      action,
      notes: notes || '',
      snoozeUntil: snoozeUntil ? new Date(snoozeUntil) : null,
      createdBy: req.user._id,
    });

    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/tfg/client-actions?centerId=...&clientHashes=hash1,hash2,...
// Devuelve mapa { clientHash: { lastAction, notes, snoozeUntil, contactedAt } }
// para los hashes pedidos. Solo considera acciones no eliminadas (deletedAt=null).
// ---------------------------------------------------------------------------
exports.getClientActions = async (req, res) => {
  try {
    const { centerId, clientHashes } = req.query;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId requerido' });
    }
    if (!mongoose.Types.ObjectId.isValid(centerId)) {
      return res.status(400).json({ success: false, message: 'centerId no es un ObjectId valido' });
    }

    const centerOid = new mongoose.Types.ObjectId(centerId);
    const hashList = clientHashes
      ? clientHashes.split(',').map((h) => h.trim()).filter(Boolean)
      : [];

    const filter = { center: centerOid, deletedAt: null };
    if (hashList.length > 0) filter.clientHash = { $in: hashList };

    // Traer todas las acciones vigentes, ordenadas por fecha desc
    const actions = await TfgClientAction.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    // Agrupar por clientHash: conservar la accion mas reciente por hash
    const map = {};
    for (const a of actions) {
      if (!map[a.clientHash]) {
        map[a.clientHash] = {
          lastAction: a.action,
          notes: a.notes || '',
          snoozeUntil: a.snoozeUntil || null,
          contactedAt: a.action === 'contacted' ? a.createdAt : null,
          actionId: a._id,
        };
      } else if (a.action === 'contacted' && !map[a.clientHash].contactedAt) {
        // Registrar la primera vez que se contacto aunque haya acciones mas recientes de otro tipo
        map[a.clientHash].contactedAt = a.createdAt;
      }
    }

    return res.json({ success: true, data: map });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/tfg/client-actions/:actionId
// Soft delete de una accion (marca deletedAt).
// ---------------------------------------------------------------------------
exports.deleteClientAction = async (req, res) => {
  try {
    const { actionId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(actionId)) {
      return res.status(400).json({ success: false, message: 'actionId no es un ObjectId valido' });
    }

    const doc = await TfgClientAction.findByIdAndUpdate(
      actionId,
      { deletedAt: new Date() },
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({ success: false, message: 'Accion no encontrada' });
    }

    return res.json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
