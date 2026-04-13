const StockConfig = require('../models/StockConfig');
const StockReport = require('../models/StockReport');
const StockAlert = require('../models/StockAlert');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');

// AMB level ordering: 'A' (highest) → 'M' → 'B' (lowest)
const AMB_ORDER = ['A', 'M', 'B'];

function isAmbAtOrBelow(value, threshold) {
  return AMB_ORDER.indexOf(value) >= AMB_ORDER.indexOf(threshold);
}

function normalizeConcept(concept) {
  return String(concept || '').trim().toLowerCase();
}

async function seedActiveAlertsFromReports(centerId) {
  const existingAlert = await StockAlert.exists({ center: centerId });
  if (existingAlert) return;

  const reports = await StockReport.find({ center: centerId })
    .sort({ date: -1 })
    .select('date submittedBy entries alertsTriggered')
    .limit(180)
    .lean();

  if (!reports.length) return;

  const seenConcepts = new Set();
  const alertsToCreate = [];

  for (const report of reports) {
    const alertsByConcept = new Map(
      (report.alertsTriggered || []).map((alert) => [normalizeConcept(alert.concept), alert])
    );

    for (const entry of report.entries || []) {
      const conceptKey = normalizeConcept(entry.concept);
      if (!conceptKey || seenConcepts.has(conceptKey)) continue;

      seenConcepts.add(conceptKey);
      const alert = alertsByConcept.get(conceptKey);

      if (alert) {
        alertsToCreate.push({
          center: centerId,
          concept: entry.concept,
          controlType: alert.controlType,
          value: alert.value,
          threshold: alert.threshold,
          status: 'active',
          lastReportDate: report.date,
          lastReportedBy: report.submittedBy,
        });
      }
    }
  }

  if (alertsToCreate.length) {
    await StockAlert.insertMany(alertsToCreate, { ordered: false });
  }
}

function isStockImproved(controlType, previousValue, currentValue) {
  if (previousValue === undefined || previousValue === null) return false;

  if (controlType === 'AMB') {
    if (!AMB_ORDER.includes(previousValue) || !AMB_ORDER.includes(currentValue)) return false;
    const score = { A: 3, M: 2, B: 1 };
    return score[currentValue] > score[previousValue];
  }

  const prevNum = parseFloat(previousValue);
  const currNum = parseFloat(currentValue);
  if (isNaN(prevNum) || isNaN(currNum)) return false;
  return currNum > prevNum;
}

function computeAlerts(items, entries) {
  const alerts = [];
  for (const entry of entries) {
    const config = items.find((item) => item.concept === entry.concept);
    if (!config) continue;
    if (config.enableAlert === false) continue;

    let triggered = false;
    if (config.controlType === 'AMB') {
      const threshold = config.alertThreshold || 'B';
      if (AMB_ORDER.includes(entry.value) && AMB_ORDER.includes(threshold)) {
        triggered = isAmbAtOrBelow(entry.value, threshold);
      }
    } else if (config.controlType === 'exact') {
      const numValue = parseFloat(entry.value);
      const numThreshold = parseFloat(config.alertThreshold);
      if (!isNaN(numValue) && !isNaN(numThreshold)) {
        triggered = numValue <= numThreshold;
      }
    }

    if (triggered) {
      alerts.push({
        concept: entry.concept,
        value: entry.value,
        threshold: config.alertThreshold,
        controlType: config.controlType,
      });
    }
  }
  return alerts;
}

// GET /api/stock/:centerId/config
exports.getStockConfig = catchAsyncErrors(async (req, res, next) => {
  const { centerId } = req.params;

  let config = await StockConfig.findOne({ center: centerId });
  if (!config) {
    config = { center: centerId, items: [] };
  }

  res.status(200).json({ success: true, config });
});

// PUT /api/stock/:centerId/config
exports.upsertStockConfig = catchAsyncErrors(async (req, res, next) => {
  const { centerId } = req.params;
  const { items } = req.body;

  if (!Array.isArray(items)) {
    return next(new ErrorHandler('items must be an array', 400));
  }

  for (const item of items) {
    if (!item.concept || typeof item.concept !== 'string') {
      return next(new ErrorHandler('Each item must have a concept', 400));
    }
    if (!['AMB', 'exact'].includes(item.controlType)) {
      return next(new ErrorHandler('controlType must be AMB or exact', 400));
    }
    if (item.daysOfWeek !== undefined) {
      if (!Array.isArray(item.daysOfWeek) || item.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        return next(new ErrorHandler('daysOfWeek must be an array of week day numbers from 0 to 6', 400));
      }
      if (item.daysOfWeek.length === 0) {
        return next(new ErrorHandler('Each item must have at least one review day', 400));
      }
    }
    if (item.reviewFrequency !== undefined && !['daily', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'monday_wednesday'].includes(item.reviewFrequency)) {
      return next(new ErrorHandler('reviewFrequency is not valid', 400));
    }
    if (item.controlType === 'AMB' && !['A', 'M', 'B'].includes(item.alertThreshold)) {
      return next(new ErrorHandler('alertThreshold for AMB must be A, M, or B', 400));
    }
    if (item.enableAlert !== undefined && typeof item.enableAlert !== 'boolean') {
      return next(new ErrorHandler('enableAlert must be true or false', 400));
    }
    if (item.enableComment !== undefined && typeof item.enableComment !== 'boolean') {
      return next(new ErrorHandler('enableComment must be true or false', 400));
    }
  }

  const config = await StockConfig.findOneAndUpdate(
    { center: centerId },
    { center: centerId, items },
    { upsert: true, new: true, runValidators: true }
  );

  res.status(200).json({ success: true, config });
});

// POST /api/stock/:centerId/reports
exports.submitStockReport = catchAsyncErrors(async (req, res, next) => {
  const { centerId } = req.params;
  const { date, entries } = req.body;

  if (!date || !Array.isArray(entries)) {
    return next(new ErrorHandler('date and entries are required', 400));
  }

  const config = await StockConfig.findOne({ center: centerId });
  const configItems = config ? config.items : [];

  const previousReport = await StockReport.findOne({
    center: centerId,
    date: { $lt: date },
  })
    .sort({ date: -1 })
    .lean();

  const previousValueByConcept = new Map();
  if (previousReport?.entries?.length) {
    for (const previousEntry of previousReport.entries) {
      previousValueByConcept.set(normalizeConcept(previousEntry.concept), previousEntry.value);
    }
  }

  const normalizedEntries = entries.map((entry) => ({
    concept: entry.concept,
    controlType: entry.controlType,
    value: entry.value,
    comment: typeof entry.comment === 'string' ? entry.comment.trim() : '',
  }));

  const alertsTriggered = computeAlerts(configItems, normalizedEntries);
  const alertByConcept = new Map(alertsTriggered.map((alert) => [normalizeConcept(alert.concept), alert]));

  // Upsert: one report per center per day
  const report = await StockReport.findOneAndUpdate(
    { center: centerId, date },
    {
      center: centerId,
      date,
      submittedBy: req.user.id,
      entries: normalizedEntries,
      alertsTriggered,
    },
    { upsert: true, new: true, runValidators: true }
  );

  // Keep one active alert per concept and replace old values with the latest report.
  const now = new Date();
  const activeAlerts = await StockAlert.find({ center: centerId, status: 'active' }).sort({ updatedAt: -1 });
  const activeAlertsByConcept = new Map();

  for (const activeAlert of activeAlerts) {
    const key = normalizeConcept(activeAlert.concept);
    if (!activeAlertsByConcept.has(key)) {
      activeAlertsByConcept.set(key, [activeAlert]);
    } else {
      activeAlertsByConcept.get(key).push(activeAlert);
    }
  }

  for (const entry of normalizedEntries) {
    const conceptKey = normalizeConcept(entry.concept);
    const conceptAlerts = activeAlertsByConcept.get(conceptKey) || [];
    const keepAlert = conceptAlerts[0] || null;
    const duplicatedAlerts = conceptAlerts.slice(1);
    const matchingTriggeredAlert = alertByConcept.get(conceptKey) || null;
    const previousValue = previousValueByConcept.get(conceptKey);
    const improved = isStockImproved(entry.controlType, previousValue, entry.value);

    if (!matchingTriggeredAlert) {
      if (keepAlert) {
        await StockAlert.updateOne(
          { _id: keepAlert._id },
          {
            $set: {
              status: 'resolved',
              resolutionReason: improved ? 'restocked' : 'back_to_safe_level',
              resolvedAt: now,
            },
          }
        );
      }

      if (duplicatedAlerts.length) {
        await StockAlert.updateMany(
          { _id: { $in: duplicatedAlerts.map((alert) => alert._id) } },
          {
            $set: {
              status: 'resolved',
              resolutionReason: 'replaced',
              resolvedAt: now,
            },
          }
        );
      }
      continue;
    }

    if (keepAlert) {
      await StockAlert.updateOne(
        { _id: keepAlert._id },
        {
          $set: {
            controlType: matchingTriggeredAlert.controlType,
            value: matchingTriggeredAlert.value,
            threshold: matchingTriggeredAlert.threshold,
            status: 'active',
            lastReportDate: date,
            lastReportedBy: req.user.id,
            resolutionReason: null,
            resolvedAt: null,
            dismissedAt: null,
            dismissedBy: null,
          },
        }
      );
    } else {
      await StockAlert.create({
        center: centerId,
        concept: entry.concept,
        controlType: matchingTriggeredAlert.controlType,
        value: matchingTriggeredAlert.value,
        threshold: matchingTriggeredAlert.threshold,
        status: 'active',
        lastReportDate: date,
        lastReportedBy: req.user.id,
      });
    }

    if (duplicatedAlerts.length) {
      await StockAlert.updateMany(
        { _id: { $in: duplicatedAlerts.map((alert) => alert._id) } },
        {
          $set: {
            status: 'resolved',
            resolutionReason: 'replaced',
            resolvedAt: now,
          },
        }
      );
    }
  }

  const populated = await report.populate('submittedBy', 'name nickname');

  res.status(200).json({ success: true, report: populated, alertsTriggered });
});

// GET /api/stock/:centerId/reports
exports.getStockReports = catchAsyncErrors(async (req, res, next) => {
  const { centerId } = req.params;
  const { from, to, date } = req.query;

  const filter = { center: centerId };
  if (date) {
    filter.date = date;
  } else if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) filter.date.$lte = to;
  }

  const reports = await StockReport.find(filter)
    .populate('submittedBy', 'name nickname')
    .sort({ date: -1 })
    .limit(60);

  res.status(200).json({ success: true, reports });
});

// GET /api/stock/:centerId/alerts
exports.getActiveStockAlerts = catchAsyncErrors(async (req, res, next) => {
  const { centerId } = req.params;

  await seedActiveAlertsFromReports(centerId);

  const alerts = await StockAlert.find({ center: centerId, status: 'active' })
    .populate('lastReportedBy', 'name nickname')
    .sort({ updatedAt: -1 });

  res.status(200).json({ success: true, alerts });
});

// DELETE /api/stock/:centerId/alerts/:alertId
exports.dismissStockAlert = catchAsyncErrors(async (req, res, next) => {
  const { centerId, alertId } = req.params;

  const alert = await StockAlert.findOne({ _id: alertId, center: centerId, status: 'active' });
  if (!alert) {
    return next(new ErrorHandler('Alerta no encontrada o ya gestionada', 404));
  }

  alert.status = 'dismissed';
  alert.dismissedAt = new Date();
  alert.dismissedBy = req.user.id;
  await alert.save();

  res.status(200).json({ success: true });
});
