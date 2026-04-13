const mongoose = require('mongoose');

const extraIncentiveSchema = new mongoose.Schema(
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
    month: {
      type: String,
      required: true,
      match: /^\d{4}-(0[1-9]|1[0-2])$/,
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
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

extraIncentiveSchema.index({ center: 1, month: 1, user: 1 });

module.exports = mongoose.model('ExtraIncentive', extraIncentiveSchema);