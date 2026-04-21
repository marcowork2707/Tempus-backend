const mongoose = require('mongoose');

const tariffSummarySchema = new mongoose.Schema(
  {
    tariff: { type: String, trim: true, default: '' },
    count: { type: Number, default: 0 },
  },
  { _id: false }
);

const activeClientRowSchema = new mongoose.Schema(
  {
    memberName: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    locality: { type: String, trim: true, default: '' },
    activeTariff: { type: String, trim: true, default: '' },
    tariffStartDate: { type: String, trim: true, default: '' },
    joinDate: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const aimHarderClientMonthlySnapshotSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    month: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    startDate: {
      type: String,
      default: '',
      trim: true,
    },
    endDate: {
      type: String,
      default: '',
      trim: true,
    },
    activeClientsCount: {
      type: Number,
      default: 0,
    },
    activeClients: {
      type: [activeClientRowSchema],
      default: [],
    },
    activeTariffSummary: {
      type: [tariffSummarySchema],
      default: [],
    },
    newSignups: {
      type: Number,
      default: 0,
    },
    monthlyCancellations: {
      type: Number,
      default: 0,
    },
    loadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

aimHarderClientMonthlySnapshotSchema.index({ center: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('AimHarderClientMonthlySnapshot', aimHarderClientMonthlySnapshotSchema);
