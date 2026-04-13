const mongoose = require('mongoose');

const stockAlertSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    concept: {
      type: String,
      required: true,
      trim: true,
      maxLength: 100,
    },
    controlType: {
      type: String,
      enum: ['AMB', 'exact'],
      required: true,
    },
    value: {
      type: String,
      required: true,
    },
    threshold: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'resolved', 'dismissed'],
      default: 'active',
      index: true,
    },
    lastReportDate: {
      type: String,
      required: true,
    },
    lastReportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    resolutionReason: {
      type: String,
      enum: ['restocked', 'back_to_safe_level', 'replaced', null],
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    dismissedAt: {
      type: Date,
      default: null,
    },
    dismissedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

stockAlertSchema.index({ center: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('StockAlert', stockAlertSchema);