const mongoose = require('mongoose');

const lessonSchema = new mongoose.Schema(
  {
    module: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrainingModule',
      required: true,
    },
    order: {
      type: Number,
      default: 0,
    },
    type: {
      type: String,
      enum: ['texto', 'video', 'checklist'],
      default: 'texto',
    },
    content: {
      type: String,
      required: [true, 'Please provide lesson content'],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Lesson', lessonSchema);
