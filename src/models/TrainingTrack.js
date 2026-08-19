const mongoose = require('mongoose');

const trainingTrackSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please provide track name'],
    },
    targetRole: {
      type: String,
      enum: ['coach', 'encargado'],
      required: [true, 'Please provide target role'],
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TrainingTrack', trainingTrackSchema);
