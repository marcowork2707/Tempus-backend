const mongoose = require('mongoose');

const vacationConflictRuleSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    primaryUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    blockedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

vacationConflictRuleSchema.index({ center: 1, primaryUser: 1, blockedUser: 1 }, { unique: true });

module.exports = mongoose.model('VacationConflictRule', vacationConflictRuleSchema);
