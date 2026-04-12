const mongoose = require('mongoose');

const appSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
    },
    value: {
      type: String,
      required: true,
    },
    centerType: {
      type: String, // 'funcional' | 'crossfit' | null (global)
      default: null,
    },
  },
  { timestamps: true }
);

// Unique per key + centerType combination
appSettingSchema.index({ key: 1, centerType: 1 }, { unique: true });

module.exports = mongoose.model('AppSetting', appSettingSchema);
