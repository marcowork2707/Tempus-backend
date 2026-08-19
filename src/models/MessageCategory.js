const mongoose = require('mongoose');

const messageCategorySchema = new mongoose.Schema(
  {
    centerType: {
      type: String,
      enum: ['funcional', 'crossfit'],
      required: true,
    },
    funnelStage: {
      type: String,
      enum: ['apertura', 'clasificacion', 'rama', 'objecion', 'seguimiento', 'alta_pago', 'confirmacion', 'gestion_cliente'],
      required: true,
    },
    name: {
      type: String,
      required: [true, 'Please provide category name'],
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MessageCategory', messageCategorySchema);
