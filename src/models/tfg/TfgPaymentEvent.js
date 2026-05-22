const mongoose = require('mongoose');

const tfgPaymentEventSchema = new mongoose.Schema(
  {
    center: { type: mongoose.Schema.Types.ObjectId, ref: 'Center', required: true, index: true },
    clientHash: { type: String, required: true, index: true },
    paymentDate: { type: Date, required: true, index: true },
    amount: { type: Number, required: true },
    concept: { type: String, trim: true, default: '' },
    tariffName: { type: String, trim: true, default: '' },
    coveredPeriod: { type: String, trim: true, default: '' },
    method: { type: String, trim: true, default: '' },
    status: { type: String, trim: true, default: '' },
  },
  { timestamps: true, collection: 'tfgpaymentevents' }
);

tfgPaymentEventSchema.index({ center: 1, clientHash: 1, paymentDate: 1 });

module.exports = mongoose.model('TfgPaymentEvent', tfgPaymentEventSchema);
