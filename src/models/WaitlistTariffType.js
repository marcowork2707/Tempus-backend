const mongoose = require('mongoose');

const waitlistTariffTypeSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    normalizedName: {
      type: String,
      required: true,
      trim: true,
    },
    price: {
      type: Number,
      default: null,
      min: 0,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

waitlistTariffTypeSchema.index({ center: 1, normalizedName: 1 }, { unique: true });

module.exports = mongoose.model('WaitlistTariffType', waitlistTariffTypeSchema);
