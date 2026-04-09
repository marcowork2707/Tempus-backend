const mongoose = require('mongoose');

const taskInstanceSchema = new mongoose.Schema(
  {
    taskTemplate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskTemplate',
      required: true,
    },
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    date: {
      type: Date,
      required: [true, 'Please provide a date'],
    },
    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shift',
    },
    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'skipped', 'overdue'],
      default: 'pending',
    },
    completedAt: Date,
    completedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: String,
  },
  { timestamps: true }
);

// Index for efficient queries
taskInstanceSchema.index({ center: 1, date: 1, status: 1 });
taskInstanceSchema.index({ assignedUser: 1, status: 1 });

module.exports = mongoose.model('TaskInstance', taskInstanceSchema);
