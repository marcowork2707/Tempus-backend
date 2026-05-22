const mongoose = require('mongoose');
const TfgChurnScore = require('../models/tfg/TfgChurnScore');
const TfgAttendanceEvent = require('../models/tfg/TfgAttendanceEvent');
const TfgActivityMetric = require('../models/tfg/TfgActivityMetric');
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
