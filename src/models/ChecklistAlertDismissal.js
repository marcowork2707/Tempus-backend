const mongoose = require('mongoose');

const checklistAlertDismissalSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    dismissedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    dismissedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

checklistAlertDismissalSchema.index({ center: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('ChecklistAlertDismissal', checklistAlertDismissalSchema);
