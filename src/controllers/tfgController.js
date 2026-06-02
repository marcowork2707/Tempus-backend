const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const TfgChurnScore = require('../models/tfg/TfgChurnScore');
const TfgAttendanceEvent = require('../models/tfg/TfgAttendanceEvent');
const TfgActivityMetric = require('../models/tfg/TfgActivityMetric');
const TfgClientActivity = require('../models/tfg/TfgClientActivity');
const TfgClientAction = require('../models/tfg/TfgClientAction');
const TfgDataCoverage = require('../models/tfg/TfgDataCoverage');
const TfgSurvivalCurve = require('../models/tfg/TfgSurvivalCurve');
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
          peakHour: precomputed.peakHour || null,
          peakDayOfWeek: precomputed.peakDayOfWeek || null,
          hourHeatmap: precomputed.hourHeatmap || [],
          attendanceByTarifa: precomputed.attendanceByTarifa || [],
          attendanceTrend: precomputed.attendanceTrend || [],
          insights: precomputed.insights || [],
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
      createdBy: req.user.id,
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
// GET /api/tfg/survival-curves?centerId=...&segmentation=global|tarifa|onramp
// Devuelve curvas Kaplan-Meier precomputadas por el batch para el centro.
// ---------------------------------------------------------------------------
exports.getSurvivalCurves = async (req, res) => {
  try {
    const { centerId, segmentation } = req.query;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId requerido' });
    }
    if (!mongoose.Types.ObjectId.isValid(centerId)) {
      return res.status(400).json({ success: false, message: 'centerId no es un ObjectId valido' });
    }

    const filter = { center: new mongoose.Types.ObjectId(centerId) };
    if (segmentation) filter.segmentation = segmentation;

    const curves = await TfgSurvivalCurve.find(filter)
      .sort({ segmentation: 1, group: 1 })
      .lean();

    return res.json({ success: true, data: curves });
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

// ---------------------------------------------------------------------------
// GET /api/tfg/executive-kpis?centerId=...&compareDays=7
// Dashboard ejecutivo: compara el corte actual con el de hace ~compareDays dias.
// ---------------------------------------------------------------------------
exports.getExecutiveKpis = async (req, res) => {
  try {
    const { centerId } = req.query;
    const compareDays = parseInt(req.query.compareDays, 10) || 7;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId requerido' });
    }
    if (!mongoose.Types.ObjectId.isValid(centerId)) {
      return res.status(400).json({ success: false, message: 'centerId no es un ObjectId valido' });
    }

    const centerOid = new mongoose.Types.ObjectId(centerId);

    // Obtener todos los cutoffDates distintos para este centro, ordenados desc
    const cutoffDates = await TfgChurnScore.distinct('cutoffDate', { center: centerOid });
    if (!cutoffDates || cutoffDates.length === 0) {
      return res.json({
        success: true,
        data: {
          currentCutoffDate: null,
          previousCutoffDate: null,
          highRiskNow: 0,
          highRiskPrev: null,
          newInHighRisk: [],
          recovered: [],
          contactedThisWeek: 0,
          contactedThisMonth: 0,
        },
      });
    }

    // Ordenar desc
    cutoffDates.sort((a, b) => new Date(b) - new Date(a));
    const currentCutoff = cutoffDates[0];

    // Buscar cutoff anterior mas cercano a (current - compareDays)
    const targetPrev = new Date(currentCutoff);
    targetPrev.setDate(targetPrev.getDate() - compareDays);

    // Encontrar el cutoff mas cercano al objetivo (diferencia minima)
    let prevCutoff = null;
    if (cutoffDates.length > 1) {
      const candidates = cutoffDates.slice(1); // excluir el actual
      prevCutoff = candidates.reduce((best, d) => {
        const diffBest = Math.abs(new Date(best) - targetPrev);
        const diffD = Math.abs(new Date(d) - targetPrev);
        return diffD < diffBest ? d : best;
      });
    }

    // Cargar scores del corte actual
    const currentScores = await TfgChurnScore.find({ center: centerOid, cutoffDate: currentCutoff })
      .select('clientHash clientName riskBand')
      .lean();

    const currentHighSet = new Set(
      currentScores.filter((s) => s.riskBand === 'high').map((s) => s.clientHash)
    );
    const currentHighMap = new Map(
      currentScores.filter((s) => s.riskBand === 'high').map((s) => [s.clientHash, s])
    );
    const highRiskNow = currentHighSet.size;

    let highRiskPrev = null;
    let newInHighRisk = [];
    let recovered = [];

    if (prevCutoff) {
      const prevScores = await TfgChurnScore.find({ center: centerOid, cutoffDate: prevCutoff })
        .select('clientHash clientName riskBand')
        .lean();

      const prevHighSet = new Set(
        prevScores.filter((s) => s.riskBand === 'high').map((s) => s.clientHash)
      );
      const prevHighMap = new Map(
        prevScores.filter((s) => s.riskBand === 'high').map((s) => [s.clientHash, s])
      );

      highRiskPrev = prevHighSet.size;

      // Nuevos en alto riesgo: en currentHigh pero NO en prevHigh
      const newHighHashes = [...currentHighSet].filter((h) => !prevHighSet.has(h));
      newInHighRisk = newHighHashes.slice(0, 5).map((h) => {
        const s = currentHighMap.get(h);
        return { clientHash: h, clientName: s?.clientName || '' };
      });

      // Recuperados: estaban en prevHigh pero ya NO en currentHigh
      const recoveredHashes = [...prevHighSet].filter((h) => !currentHighSet.has(h));
      recovered = recoveredHashes.slice(0, 5).map((h) => {
        const s = prevHighMap.get(h);
        return { clientHash: h, clientName: s?.clientName || '' };
      });
    }

    // Contactados en ultimos 7 y 30 dias
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [contactedThisWeek, contactedThisMonth] = await Promise.all([
      TfgClientAction.countDocuments({
        center: centerOid,
        action: 'contacted',
        deletedAt: null,
        createdAt: { $gte: weekAgo },
      }),
      TfgClientAction.countDocuments({
        center: centerOid,
        action: 'contacted',
        deletedAt: null,
        createdAt: { $gte: monthAgo },
      }),
    ]);

    return res.json({
      success: true,
      data: {
        currentCutoffDate: currentCutoff instanceof Date
          ? currentCutoff.toISOString().slice(0, 10)
          : String(currentCutoff).slice(0, 10),
        previousCutoffDate: prevCutoff
          ? (prevCutoff instanceof Date ? prevCutoff.toISOString().slice(0, 10) : String(prevCutoff).slice(0, 10))
          : null,
        highRiskNow,
        highRiskPrev,
        newInHighRisk,
        recovered,
        contactedThisWeek,
        contactedThisMonth,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/tfg/model-info?centerId=...
// Informacion del modelo: metadata, historico de ejecuciones, distribucion de
// scores y top features globales por mean SHAP del ultimo corte.
// ---------------------------------------------------------------------------
exports.getModelInfo = async (req, res) => {
  try {
    const { centerId } = req.query;

    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId requerido' });
    }
    if (!mongoose.Types.ObjectId.isValid(centerId)) {
      return res.status(400).json({ success: false, message: 'centerId no es un ObjectId valido' });
    }

    const centerOid = new mongoose.Types.ObjectId(centerId);

    // --- modelMeta: leer del filesystem ---
    let modelMeta = null;
    try {
      const metaPath = path.resolve(__dirname, '../../../tfg-ml/models/best_model_metadata.json');
      if (fs.existsSync(metaPath)) {
        const raw = fs.readFileSync(metaPath, 'utf8');
        const parsed = JSON.parse(raw);
        modelMeta = {
          name: parsed.model_name || null,
          trainDate: parsed.train_date || null,
          version: parsed.train_date
            ? `${parsed.train_date.slice(0, 10)}_${(parsed.model_name || '').replace(/\s/g, '')}`
            : null,
          calibration: parsed.calibration || null,
          testMetrics: parsed.test_metrics || null,
          featureNames: parsed.feature_names || [],
        };
      }
    } catch (_) {
      modelMeta = null;
    }

    // --- batchRuns: agregar por cutoffDate para TODOS los centros ---
    // Primero obtener todos los centros para saber sus nombres
    const allCenters = await Center.find({}).select('_id name').lean();
    const centerNameMap = {};
    allCenters.forEach((c) => { centerNameMap[String(c._id)] = c.name; });

    const batchAgg = await TfgChurnScore.aggregate([
      {
        $group: {
          _id: { cutoffDate: '$cutoffDate', center: '$center', riskBand: '$riskBand' },
          count: { $sum: 1 },
          avgScore: { $avg: '$score' },
        },
      },
      { $sort: { '_id.cutoffDate': -1 } },
    ]);

    // Reagrupar por cutoffDate
    const batchMap = new Map();
    for (const row of batchAgg) {
      const dateKey = row._id.cutoffDate instanceof Date
        ? row._id.cutoffDate.toISOString().slice(0, 10)
        : String(row._id.cutoffDate).slice(0, 10);
      const cid = String(row._id.center);
      const band = row._id.riskBand;

      if (!batchMap.has(dateKey)) {
        batchMap.set(dateKey, {
          cutoffDate: dateKey,
          totalClients: 0,
          highRiskCount: 0,
          mediumRiskCount: 0,
          lowRiskCount: 0,
          avgScore: 0,
          _scoreSum: 0,
          _scoreCount: 0,
          byCenter: {},
        });
      }
      const entry = batchMap.get(dateKey);
      entry.totalClients += row.count;
      if (band === 'high') entry.highRiskCount += row.count;
      if (band === 'medium') entry.mediumRiskCount += row.count;
      if (band === 'low') entry.lowRiskCount += row.count;
      entry._scoreSum += row.avgScore * row.count;
      entry._scoreCount += row.count;

      const cname = centerNameMap[cid] || cid;
      if (!entry.byCenter[cname]) entry.byCenter[cname] = { total: 0, high: 0 };
      entry.byCenter[cname].total += row.count;
      if (band === 'high') entry.byCenter[cname].high += row.count;
    }

    const batchRuns = [...batchMap.values()]
      .sort((a, b) => b.cutoffDate.localeCompare(a.cutoffDate))
      .slice(0, 20)
      .map((e) => ({
        cutoffDate: e.cutoffDate,
        totalClients: e.totalClients,
        highRiskCount: e.highRiskCount,
        mediumRiskCount: e.mediumRiskCount,
        lowRiskCount: e.lowRiskCount,
        avgScore: e._scoreCount > 0 ? parseFloat((e._scoreSum / e._scoreCount).toFixed(4)) : 0,
        byCenter: e.byCenter,
      }));

    // --- scoreDistribution: ultimo corte del centro solicitado ---
    const latestCutoffDoc = await TfgChurnScore.findOne({ center: centerOid })
      .sort({ cutoffDate: -1 })
      .select('cutoffDate')
      .lean();

    let scoreDistribution = [];
    if (latestCutoffDoc) {
      const allScores = await TfgChurnScore.find({
        center: centerOid,
        cutoffDate: latestCutoffDoc.cutoffDate,
      })
        .select('score')
        .lean();

      // 10 buckets uniformes 0-1
      const buckets = Array.from({ length: 10 }, (_, i) => ({
        bucket: `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`,
        count: 0,
      }));
      for (const s of allScores) {
        const idx = Math.min(Math.floor(s.score * 10), 9);
        buckets[idx].count++;
      }
      scoreDistribution = buckets;
    }

    // --- topGlobalFeatures: mean SHAP del ultimo corte del centro ---
    let topGlobalFeatures = [];
    if (latestCutoffDoc) {
      const featureAgg = await TfgChurnScore.aggregate([
        { $match: { center: centerOid, cutoffDate: latestCutoffDoc.cutoffDate } },
        { $unwind: '$topFeatures' },
        {
          $group: {
            _id: '$topFeatures.name',
            meanShap: { $avg: '$topFeatures.contribution' },
            count: { $sum: 1 },
          },
        },
        { $sort: { meanShap: -1 } },
        { $limit: 10 },
      ]);
      topGlobalFeatures = featureAgg.map((f) => ({
        name: f._id,
        meanShap: parseFloat(f.meanShap.toFixed(4)),
      }));
    }

    return res.json({
      success: true,
      data: {
        modelMeta,
        batchRuns,
        scoreDistribution,
        topGlobalFeatures,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// Helpers comunes para los endpoints de import-jobs
// ---------------------------------------------------------------------------

const ML_SERVICE_URL = () => process.env.TFG_ML_SERVICE_URL || 'http://localhost:8000';

function handleMlServiceError(err, res) {
  if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ERR_CANCELED') {
    return res.status(503).json({
      success: false,
      message: 'Servicio de procesamiento no disponible. Asegurate de que el microservicio Python esta en ejecucion.',
    });
  }
  if (err.response) {
    const status = err.response.status;
    if (status === 422) {
      return res.status(422).json({ success: false, message: err.response.data?.detail || 'Validacion fallida en el servicio Python.' });
    }
    return res.status(500).json({ success: false, message: 'Error interno en el servicio de procesamiento.' });
  }
  return res.status(503).json({
    success: false,
    message: 'Servicio de procesamiento no disponible.',
  });
}

// ---------------------------------------------------------------------------
// POST /api/tfg/import-jobs
// Recibe CSVs del frontend (multipart) y los reenvía al microservicio Python.
// Multer (memoryStorage) debe estar configurado en la ruta antes de llamar aquí.
// ---------------------------------------------------------------------------
exports.importJobsCreate = async (req, res) => {
  try {
    const files = req.files;
    const { center } = req.body;

    if (!center) {
      return res.status(400).json({ success: false, message: 'El campo center es requerido.' });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: 'Se requiere al menos un archivo CSV.' });
    }

    if (files.length > 10) {
      return res.status(400).json({ success: false, message: 'Maximo 10 archivos por envio.' });
    }

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
    if (totalBytes > MAX_BYTES) {
      return res.status(400).json({ success: false, message: 'El tamano total de los archivos supera el limite de 50 MB.' });
    }

    for (const f of files) {
      if (!f.originalname.toLowerCase().endsWith('.csv')) {
        return res.status(400).json({ success: false, message: `El archivo "${f.originalname}" no es un CSV.` });
      }
    }

    const form = new FormData();
    form.append('center', center);
    for (const f of files) {
      form.append('files', f.buffer, { filename: f.originalname, contentType: 'text/csv' });
    }

    const response = await axios.post(
      `${ML_SERVICE_URL()}/jobs/process`,
      form,
      {
        headers: form.getHeaders(),
        timeout: 30000,
      }
    );

    return res.status(202).json({ success: true, data: response.data });
  } catch (err) {
    return handleMlServiceError(err, res);
  }
};

// ---------------------------------------------------------------------------
// GET /api/tfg/import-jobs/:jobId
// Proxy puro al microservicio Python GET /jobs/{jobId}.
// ---------------------------------------------------------------------------
exports.importJobsGet = async (req, res) => {
  try {
    const { jobId } = req.params;

    const response = await axios.get(
      `${ML_SERVICE_URL()}/jobs/${encodeURIComponent(jobId)}`,
      { timeout: 10000 }
    );

    return res.json({ success: true, data: response.data });
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).json({ success: false, message: 'Job no encontrado.' });
    }
    return handleMlServiceError(err, res);
  }
};

// ---------------------------------------------------------------------------
// GET /api/tfg/import-jobs
// Lista los ultimos N jobs del microservicio Python.
// ---------------------------------------------------------------------------
exports.importJobsList = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);

    const response = await axios.get(
      `${ML_SERVICE_URL()}/jobs`,
      { params: { limit }, timeout: 10000 }
    );

    return res.json({ success: true, data: response.data });
  } catch (err) {
    return handleMlServiceError(err, res);
  }
};

// ---------------------------------------------------------------------------
// GET /api/tfg/data-coverage?centerId=...
// Devuelve la fecha hasta la que hay datos cargados por tipo de CSV.
// ---------------------------------------------------------------------------
exports.getDataCoverage = async (req, res) => {
  try {
    const { centerId } = req.query;
    if (!centerId) {
      return res.status(400).json({ success: false, message: 'centerId requerido' });
    }
    if (!mongoose.Types.ObjectId.isValid(centerId)) {
      return res.status(400).json({ success: false, message: 'centerId no valido' });
    }
    const doc = await TfgDataCoverage.findOne({ center: new mongoose.Types.ObjectId(centerId) }).lean();
    if (!doc) {
      return res.json({
        success: true,
        data: null,
        message: 'Sin cobertura registrada todavia. Ejecuta una ingesta para inicializarla.',
      });
    }
    return res.json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
