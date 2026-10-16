const mongoose = require('mongoose');

const bookingAthleteSchema = new mongoose.Schema(
  {
    aimharderUserId: { type: String, default: '', trim: true },
    name: { type: String, default: '', trim: true },
    membership: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const bookingClassSchema = new mongoose.Schema(
  {
    className: { type: String, default: '', trim: true },
    classTime: { type: String, default: '', trim: true },
    coachName: { type: String, default: '', trim: true },
    capacity: { type: Number, default: 0, min: 0 },
    bookedCount: { type: Number, default: 0, min: 0 },
    athletes: { type: [bookingAthleteSchema], default: [] },
  },
  { _id: false }
);

// Reservas por cliente de un día (solo apuntados reales). Alimenta el informe de Capacidad.
const centerBookingSnapshotSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
      index: true,
    },
    date: {
      type: String,
      required: true,
      index: true,
    },
    classes: {
      type: [bookingClassSchema],
      default: [],
    },
    refreshedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

centerBookingSnapshotSchema.index({ center: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('CenterBookingSnapshot', centerBookingSnapshotSchema);
