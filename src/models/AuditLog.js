const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    action: {
      type: String,
      required: [true, 'Please provide action'],
    },
    entityType: {
      type: String,
      required: [true, 'Please provide entity type'],
    },
    entityId: mongoose.Schema.Types.ObjectId,
    metadata: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

// Index for efficient queries
auditLogSchema.index({ user: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
