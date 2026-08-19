const mongoose = require('mongoose');

const examQuestionOptionSchema = new mongoose.Schema(
  {
    text: String,
    correct: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const examQuestionSchema = new mongoose.Schema(
  {
    module: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrainingModule',
      required: true,
    },
    prompt: {
      type: String,
      required: [true, 'Please provide question prompt'],
    },
    type: {
      type: String,
      enum: ['unica', 'multiple', 'escenario'],
      default: 'unica',
    },
    options: [examQuestionOptionSchema],
    explanation: String,
    order: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ExamQuestion', examQuestionSchema);
