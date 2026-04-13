const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const validator = require('validator');

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: [true, 'Please provide a first name'],
      maxLength: [30, 'First name cannot exceed 30 characters'],
      minLength: [2, 'First name should have more than 2 characters'],
    },
    lastName: {
      type: String,
      required: [true, 'Please provide a last name'],
      maxLength: [30, 'Last name cannot exceed 30 characters'],
      minLength: [2, 'Last name should have more than 2 characters'],
    },
    name: {
      type: String,
      required: [true, 'Please provide a name'],
      maxLength: [60, 'Name cannot exceed 60 characters'],
    },
    nickname: {
      type: String,
      maxLength: [30, 'Nickname cannot exceed 30 characters'],
      default: '',
    },
    email: {
      type: String,
      required: [true, 'Please provide an email'],
      unique: true,
      validate: [validator.isEmail, 'Please provide a valid email'],
    },
    dni: {
      type: String,
      required: [true, 'Please provide a DNI'],
      unique: true,
      regex: [/^\d{8}[A-Z]$/, 'DNI format should be 8 digits followed by a letter (e.g., 12345678A)'],
    },
    password: {
      type: String,
      required: [true, 'Please provide a password'],
      minLength: [6, 'Password should be greater than 6 characters'],
      select: false,
    },
    mustSetPassword: {
      type: Boolean,
      default: false,
    },
    invitationStatus: {
      type: String,
      enum: ['active', 'pending'],
      default: 'active',
    },
    activationToken: {
      type: String,
      default: null,
      select: false,
    },
    activationTokenExpires: {
      type: Date,
      default: null,
      select: false,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre('save', async function () {
  if (!this.isModified('password')) {
    return;
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Match password
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
