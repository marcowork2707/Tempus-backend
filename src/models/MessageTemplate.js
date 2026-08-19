const mongoose = require('mongoose');

const messageTemplateSchema = new mongoose.Schema(
  {
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MessageCategory',
      required: true,
    },
    title: {
      type: String,
      required: [true, 'Please provide template title'],
    },
    body: {
      type: String,
      required: [true, 'Please provide template body'],
    },
    branch: String, // free-text tag e.g. 'funcional' | '+65' | 'pt' | 'crossfit_si' | 'iniciacion' | 'lista_espera' | 'congelacion'
    order: {
      type: Number,
      default: 0,
    },
    lastEditedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    lastEditedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('MessageTemplate', messageTemplateSchema);
