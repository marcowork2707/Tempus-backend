const mongoose = require('mongoose');

const userCenterRoleSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    role: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
      required: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    weeklyContractHours: {
      type: Number,
      min: [0, 'weeklyContractHours cannot be negative'],
      default: null,
    },
  },
  { timestamps: true }
);

// Compound unique index
userCenterRoleSchema.index(
  { user: 1, center: 1, role: 1 },
  { unique: true }
);

module.exports = mongoose.model('UserCenterRole', userCenterRoleSchema);
