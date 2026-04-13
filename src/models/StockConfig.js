const mongoose = require('mongoose');

const stockItemSchema = new mongoose.Schema({
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
    default: 'AMB',
  },
  daysOfWeek: {
    type: [Number],
    default: [1, 3],
  },
  reviewFrequency: {
    type: String,
    enum: ['daily', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'monday_wednesday'],
    default: 'monday_wednesday',
  },
  // For AMB: 'A', 'M', or 'B' — alert when stock is AT or BELOW this level
  // For exact: the number as a string — alert when value <= this number
  alertThreshold: {
    type: String,
    required: true,
    default: 'B',
  },
  enableAlert: {
    type: Boolean,
    default: true,
  },
  enableComment: {
    type: Boolean,
    default: false,
  },
});

const stockConfigSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      unique: true,
    },
    items: [stockItemSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('StockConfig', stockConfigSchema);
