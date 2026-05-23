const mongoose = require('mongoose');

const tfgClientActionSchema = new mongoose.Schema(
  {
    center: { type: mongoose.Schema.Types.ObjectId, ref: 'Center', required: true },
    clientHash: { type: String, required: true },
    action: {
      type: String,
      enum: ['contacted', 'snoozed', 'false_positive'],
      required: true,
    },
    notes: { type: String, default: '' },
    snoozeUntil: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'tfgclientactions' }
);

tfgClientActionSchema.index({ center: 1, clientHash: 1, createdAt: -1 });

module.exports = mongoose.model('TfgClientAction', tfgClientActionSchema);
