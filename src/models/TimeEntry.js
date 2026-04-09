const mongoose = require('mongoose');

const timeEntrySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: 'User',
      required: true,
    },
    center: {
      type: mongoose.Schema.ObjectId,
      ref: 'Center',
      required: true,
    },
    date: {
      type: Date,
      default: () => {
        const today = new Date();
        return new Date(today.getFullYear(), today.getMonth(), today.getDate());
      },
    },
    entryTime: {
      type: Date,
      required: true,
    },
    exitTime: {
      type: Date,
      default: null,
    },
    duration: {
      type: Number,
      default: null, // in minutes
    },
    notes: String,
    status: {
      type: String,
      enum: ['active', 'completed'],
      default: 'active',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TimeEntry', timeEntrySchema);
