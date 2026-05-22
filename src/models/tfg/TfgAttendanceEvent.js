const mongoose = require('mongoose');

const tfgAttendanceEventSchema = new mongoose.Schema(
  {
    center: { type: mongoose.Schema.Types.ObjectId, ref: 'Center', required: true, index: true },
    clientHash: { type: String, required: true, index: true },
    classDateTime: { type: Date, required: true, index: true },
    classType: { type: String, trim: true, default: '' },
    reservationStatus: {
      type: String,
      enum: ['attended', 'no_show', 'cancelled_user', 'cancelled_box', 'waitlist'],
      required: true,
    },
  },
  { timestamps: true, collection: 'tfgattendanceevents' }
);

tfgAttendanceEventSchema.index({ center: 1, clientHash: 1, classDateTime: 1 });

module.exports = mongoose.model('TfgAttendanceEvent', tfgAttendanceEventSchema);
