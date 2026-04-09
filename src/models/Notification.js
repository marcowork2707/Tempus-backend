const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    taskInstance: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskInstance',
    },
    channel: {
      type: String,
      enum: ['email', 'push', 'in-app'],
      default: 'email',
    },
    scheduledFor: {
      type: Date,
      required: true,
    },
    sentAt: Date,
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed'],
      default: 'pending',
    },
    subject: String,
    message: String,
  },
  { timestamps: true }
);

// Index for pending notifications
notificationSchema.index({ status: 1, scheduledFor: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
