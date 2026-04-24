const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please provide a role name'],
      enum: ['admin', 'encargado', 'coach', 'limpieza'],
      unique: true,
    },
    description: String,
    permissions: [String], // List of permissions
  },
  { timestamps: true }
);

module.exports = mongoose.model('Role', roleSchema);
