const mongoose = require('mongoose');

const tfgChurnScoreSchema = new mongoose.Schema(
  {
    center: { type: mongoose.Schema.Types.ObjectId, ref: 'Center', required: true, index: true },
    clientHash: { type: String, required: true, index: true },
    cutoffDate: { type: Date, required: true, index: true },
    horizonDays: { type: Number, required: true },
    score: { type: Number, required: true, min: 0, max: 1 },
    riskBand: { type: String, enum: ['low', 'medium', 'high'], required: true },
    modelVersion: { type: String, required: true },
    topFeatures: [{ name: String, contribution: Number }],
    clientName: { type: String, default: '' },
    phone: { type: String, default: '' },
    aimharderId: { type: String, default: '' },
    daysSinceLastAttendance: { type: Number, default: null },
    lastAttendance: { type: Date, default: null },
    tarifa: { type: String, default: '' },
    cohortType: { type: String, enum: ['regular', 'onramp'], default: 'regular' },
  },
  { timestamps: true, collection: 'tfgchurnscores' }
);

tfgChurnScoreSchema.index({ center: 1, cutoffDate: 1, score: -1 });
tfgChurnScoreSchema.index({ center: 1, clientHash: 1, cutoffDate: 1 }, { unique: true });

module.exports = mongoose.model('TfgChurnScore', tfgChurnScoreSchema);
