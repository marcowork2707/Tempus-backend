const mongoose = require('mongoose');

const trainingAttemptSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    module: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrainingModule',
      required: true,
    },
    answers: mongoose.Schema.Types.Mixed,
    score: {
      type: Number,
      required: true,
    },
    passed: {
      type: Boolean,
      required: true,
    },
    passingThreshold: {
      type: Number,
      default: 8,
    },
    attemptedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

trainingAttemptSchema.index({ user: 1, module: 1 });

module.exports = mongoose.model('TrainingAttempt', trainingAttemptSchema);
