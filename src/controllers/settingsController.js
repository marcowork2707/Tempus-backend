const AppSetting = require('../models/AppSetting');
const catchAsyncErrors = require('../utils/catchAsyncErrors');
const ErrorHandler = require('../utils/errorHandler');

// GET /api/settings?key=xxx&centerType=yyy
exports.getSettings = catchAsyncErrors(async (req, res) => {
  const { key, centerType } = req.query;

  const query = {};
  if (key) query.key = key;
  if (centerType !== undefined) query.centerType = centerType || null;

  const settings = await AppSetting.find(query);
  res.status(200).json({ success: true, settings });
});

// PUT /api/settings  body: { key, value, centerType? }
exports.upsertSetting = catchAsyncErrors(async (req, res, next) => {
  const { key, value, centerType = null } = req.body;

  if (!key || value === undefined) {
    return next(new ErrorHandler('key and value are required', 400));
  }

  const setting = await AppSetting.findOneAndUpdate(
    { key, centerType },
    { value },
    { upsert: true, new: true, runValidators: true }
  );

  res.status(200).json({ success: true, setting });
});
