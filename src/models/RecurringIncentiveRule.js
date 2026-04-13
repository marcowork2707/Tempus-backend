const mongoose = require('mongoose');

const recurringIncentiveRuleSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    concept: {
      type: String,
      required: true,
      trim: true,
      maxlength: 140,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    startMonth: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
    },
    endMonth: {
      type: String,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
    },
    active: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

recurringIncentiveRuleSchema.index({ center: 1, user: 1, active: 1 });

module.exports = mongoose.model('RecurringIncentiveRule', recurringIncentiveRuleSchema);