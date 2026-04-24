const mongoose = require('mongoose');

const checklistItemSchema = new mongoose.Schema({
  label: {
    type: String,
    required: [true, 'Please provide item label'],
  },
  done: {
    type: Boolean,
    default: false,
  },
  doneAt: Date,
  doneBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
});

const checklistSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    type: {
      type: String,
      enum: ['daily', 'opening', 'closing', 'cleaning'],
      default: 'daily',
    },
    items: {
      type: [checklistItemSchema],
      default: [],
    },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'reviewed'],
      default: 'pending',
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: Date,
    reviewNotes: String,
  },
  { timestamps: true }
);

checklistSchema.index({ center: 1, assignedUser: 1, date: 1 });
checklistSchema.index({ center: 1, type: 1, date: 1 });

module.exports = mongoose.model('Checklist', checklistSchema);
