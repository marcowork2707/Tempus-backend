const mongoose = require('mongoose');

const taskTemplateSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    title: {
      type: String,
      required: [true, 'Please provide task title'],
    },
    description: String,
    taskType: {
      type: String,
      enum: ['opening', 'closing', 'daily'],
      required: [true, 'Please provide task type'],
    },
    assignedRole: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
    },
    assignedShift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shift',
    },
    recurrenceType: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'specific_days'],
      default: 'daily',
    },
    recurrenceConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    reminderTime: {
      type: Number, // minutes before
      default: 30,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TaskTemplate', taskTemplateSchema);
