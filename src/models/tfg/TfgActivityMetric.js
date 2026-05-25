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
    // Nuevos campos — dashboard UX6
    peakHour: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      // { hour: Number, count: Number }
    },
    peakDayOfWeek: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      // { day: String ('monday'...'sunday'), count: Number }
    },
    hourHeatmap: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
      // [{ dayOfWeek: String, hour: Number, count: Number }]
    },
    attendanceByTarifa: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
      // [{ tarifa: String, totalAttendances: Number, uniqueClients: Number, avgPerClient: Number }]
    },
    attendanceTrend: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
      // [{ month: 'YYYY-MM', count: Number }]
    },
    insights: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true, collection: 'tfgactivitymetrics' }
);

tfgActivityMetricSchema.index({ center: 1, cutoffDate: 1, rangeKey: 1 }, { unique: true });

module.exports = mongoose.model('TfgActivityMetric', tfgActivityMetricSchema);
