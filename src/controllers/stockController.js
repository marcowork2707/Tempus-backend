const StockConfig = require('../models/StockConfig');
const StockReport = require('../models/StockReport');
const ErrorHandler = require('../utils/errorHandler');
const catchAsyncErrors = require('../utils/catchAsyncErrors');

// AMB level ordering: 'A' (highest) → 'M' → 'B' (lowest)
const AMB_ORDER = ['A', 'M', 'B'];

function isAmbAtOrBelow(value, threshold) {
  return AMB_ORDER.indexOf(value) >= AMB_ORDER.indexOf(threshold);
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

  const normalizedEntries = entries.map((entry) => ({
    concept: entry.concept,
    controlType: entry.controlType,
    value: entry.value,
    comment: typeof entry.comment === 'string' ? entry.comment.trim() : '',
  }));

  const alertsTriggered = computeAlerts(configItems, normalizedEntries);

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
