const mongoose = require('mongoose');

const trainingModuleSchema = new mongoose.Schema(
  {
    track: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrainingTrack',
      required: true,
    },
    title: {
      type: String,
      required: [true, 'Please provide module title'],
    },
    summary: String,
    order: {
      type: Number,
      default: 0,
    },
    estimatedMinutes: Number,
    centerType: {
      type: String, // 'funcional' | 'crossfit' | null (applies to both brands)
      enum: ['funcional', 'crossfit', null],
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TrainingModule', trainingModuleSchema);
