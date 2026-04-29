const mongoose = require('mongoose');

const tariffItemSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    price: {
      type: Number,
      default: null,
      min: 0,
    },
    aliases: {
      type: [String],
      default: [],
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { _id: true }
);

const centerTariffGroupSchema = new mongoose.Schema(
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
      maxlength: 80,
    },
    order: {
      type: Number,
      default: 0,
    },
    active: {
      type: Boolean,
      default: true,
    },
    items: {
      type: [tariffItemSchema],
      default: [],
    },
  },
  { timestamps: true }
);

centerTariffGroupSchema.index({ center: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('CenterTariffGroup', centerTariffGroupSchema);
