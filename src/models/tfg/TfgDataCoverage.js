const mongoose = require('mongoose');

const tfgDataCoverageSchema = new mongoose.Schema(
  {
    center: { type: mongoose.Schema.Types.ObjectId, ref: 'Center', required: true, unique: true },
    lastReservation: { type: Date, default: null },
    lastAttendanceMiss: { type: Date, default: null },
    lastPayment: { type: Date, default: null },
    lastCancellation: { type: Date, default: null },
    lastClientSnapshot: { type: Date, default: null },
    lastIngestRun: { type: Date, default: null },
    totalClientsActive: { type: Number, default: 0 },
    totalCancellations: { type: Number, default: 0 },
    totalReservations: { type: Number, default: 0 },
    totalPayments: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'tfgdatacoverage' }
);

module.exports = mongoose.model('TfgDataCoverage', tfgDataCoverageSchema);
