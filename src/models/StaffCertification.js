const mongoose = require('mongoose');

const staffCertificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    track: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrainingTrack',
      required: true,
    },
    modulesCompleted: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TrainingModule',
      },
    ],
    certifiedAt: Date,
  },
  { timestamps: true }
);

staffCertificationSchema.index({ user: 1, track: 1 }, { unique: true });

module.exports = mongoose.model('StaffCertification', staffCertificationSchema);
