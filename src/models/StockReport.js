const mongoose = require('mongoose');

const stockEntrySchema = new mongoose.Schema({
  concept: { type: String, required: true, trim: true },
  controlType: { type: String, enum: ['AMB', 'exact'], required: true },
  value: { type: String, required: true },
  comment: { type: String, default: '', trim: true, maxLength: 300 },
});

const stockAlertSchema = new mongoose.Schema({
  concept: { type: String, required: true },
  value: { type: String, required: true },
  threshold: { type: String, required: true },
  controlType: { type: String, enum: ['AMB', 'exact'], required: true },
});

const stockReportSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    date: {
      type: String, // YYYY-MM-DD
      required: true,
    },
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    entries: [stockEntrySchema],
    alertsTriggered: [stockAlertSchema],
  },
  { timestamps: true }
);

// One report per center per day
stockReportSchema.index({ center: 1, date: 1 });

module.exports = mongoose.model('StockReport', stockReportSchema);
