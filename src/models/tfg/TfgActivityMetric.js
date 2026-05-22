const mongoose = require('mongoose');

const tfgActivityMetricSchema = new mongoose.Schema(
  {
    center: { type: mongoose.Schema.Types.ObjectId, ref: 'Center', required: true, index: true },
    cutoffDate: { type: Date, required: true, index: true },
    rangeKey: { type: String, enum: ['1m', '3m', '6m'], required: true },
    totalAttendances: { type: Number, default: 0 },
    noShowRate: { type: Number, default: null },
    topClasses: [{ classType: String, count: Number }],
    weeklyAttendance: [{ weekStart: String, count: Number }],
  },
  { timestamps: true, collection: 'tfgactivitymetrics' }
);

tfgActivityMetricSchema.index({ center: 1, cutoffDate: 1, rangeKey: 1 }, { unique: true });

module.exports = mongoose.model('TfgActivityMetric', tfgActivityMetricSchema);
