const mongoose = require('mongoose');

const timeSegmentSchema = new mongoose.Schema(
  {
    startTime: {
      type: String,
      required: true,
      match: [/^\d{2}:\d{2}$/, 'startTime must be HH:MM'],
    },
    endTime: {
      type: String,
      required: true,
      match: [/^\d{2}:\d{2}$/, 'endTime must be HH:MM'],
    },
  },
  { _id: false }
);

const dayTimeOverrideSchema = new mongoose.Schema(
  {
    dayOfWeek: {
      type: Number,
      required: true,
      min: 0,
      max: 6,
    },
    startTime: {
      type: String,
      match: [/^\d{2}:\d{2}$/, 'startTime must be HH:MM'],
    },
    endTime: {
      type: String,
      match: [/^\d{2}:\d{2}$/, 'endTime must be HH:MM'],
    },
    segments: {
      type: [timeSegmentSchema],
      default: [],
    },
  },
  { _id: false }
);

/**
 * A ShiftPattern defines a recurring schedule for a specific worker at a center.
 * Instead of storing individual shift assignments per day, a pattern captures
 * the recurrence rule (weekly, biweekly, monthly) and the days/times it applies.
 *
 * Recurrence logic:
 *   - 'once'     : applies only within [startDate, endDate] on the specified daysOfWeek
 *   - 'weekly'   : repeats every week on specified daysOfWeek
 *   - 'biweekly' : repeats every 2 weeks (from the week containing startDate)
 *   - 'monthly'  : repeats every 4 weeks (≈ monthly) from startDate
 *   - 'custom_cycle' : repeats on specific weeks within an arbitrary cycle length
 */
const shiftPatternSchema = new mongoose.Schema(
  {
    center: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Center',
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shift',
      default: null,
    },
    label: {
      type: String,
      trim: true,
      maxlength: [80, 'Label cannot exceed 80 characters'],
    },
    // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
    daysOfWeek: {
      type: [Number],
      required: [true, 'At least one day of week is required'],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0 && arr.every((d) => d >= 0 && d <= 6),
        message: 'daysOfWeek must be a non-empty array of integers 0-6',
      },
    },
    // Optional time overrides (if different from the linked Shift definition)
    startTimeOverride: {
      type: String,
      match: [/^\d{2}:\d{2}$/, 'startTimeOverride must be HH:MM'],
    },
    endTimeOverride: {
      type: String,
      match: [/^\d{2}:\d{2}$/, 'endTimeOverride must be HH:MM'],
    },
    timeSegments: {
      type: [timeSegmentSchema],
      default: [],
    },
    dayTimeOverrides: {
      type: [dayTimeOverrideSchema],
      default: [],
    },
    recurrence: {
      type: String,
      enum: ['once', 'weekly', 'biweekly', 'monthly', 'custom_cycle'],
      default: 'weekly',
    },
    cycleLengthWeeks: {
      type: Number,
      min: [1, 'cycleLengthWeeks must be at least 1'],
      max: [12, 'cycleLengthWeeks cannot exceed 12'],
      default: 1,
    },
    cycleWeeks: {
      type: [Number],
      default: undefined,
      validate: {
        validator: (arr) =>
          arr === undefined ||
          (Array.isArray(arr) && arr.length > 0 && arr.every((d) => Number.isInteger(d) && d >= 1 && d <= 12)),
        message: 'cycleWeeks must be an array of integers between 1 and 12',
      },
    },
    startDate: {
      type: Date,
      required: [true, 'startDate is required'],
    },
    endDate: {
      type: Date,
      default: null, // null = indefinite
    },
    active: {
      type: Boolean,
      default: true,
    },
    notes: {
      type: String,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
  },
  { timestamps: true }
);

shiftPatternSchema.index({ center: 1, user: 1 });
shiftPatternSchema.index({ center: 1, active: 1, startDate: 1 });

shiftPatternSchema.pre('validate', function () {
  if (this.recurrence !== 'custom_cycle') {
    if (!this.cycleLengthWeeks) this.cycleLengthWeeks = 1;
    if (!this.cycleWeeks || this.cycleWeeks.length === 0) this.cycleWeeks = [1];
  }

  if (!this.cycleLengthWeeks || this.cycleLengthWeeks < 1) {
    this.invalidate('cycleLengthWeeks', 'cycleLengthWeeks is required for custom_cycle');
  }

  if (!this.cycleWeeks || this.cycleWeeks.length === 0) {
    this.invalidate('cycleWeeks', 'cycleWeeks is required for custom_cycle');
  } else if (this.cycleWeeks.some((week) => week > this.cycleLengthWeeks)) {
    this.invalidate('cycleWeeks', 'cycleWeeks cannot contain values greater than cycleLengthWeeks');
  }

  if (this.dayTimeOverrides?.some((override) => !this.daysOfWeek.includes(override.dayOfWeek))) {
    this.invalidate('dayTimeOverrides', 'dayTimeOverrides can only be defined for selected daysOfWeek');
  }
  if ((this.timeSegments || []).length > 0 && (this.startTimeOverride || this.endTimeOverride)) {
    this.invalidate('timeSegments', 'Use either start/end override or timeSegments, not both');
  }
  const hasValidSegments = (segments = []) =>
    Array.isArray(segments) && segments.length > 0 && segments.every((segment) => segment.startTime && segment.endTime);
  if ((this.dayTimeOverrides || []).some((override) => !hasValidSegments(override.segments) && !(override.startTime && override.endTime))) {
    this.invalidate('dayTimeOverrides', 'Each dayTimeOverride must define a complete time range or at least one segment');
  }
  const hasBaseShift = !!this.shift;
  const hasGlobalHours = !!this.startTimeOverride && !!this.endTimeOverride;
  const hasGlobalSegments = hasValidSegments(this.timeSegments);
  const daysCoveredByOverrides = new Set(
    (this.dayTimeOverrides || [])
      .filter((override) => (override.startTime && override.endTime) || hasValidSegments(override.segments))
      .map((override) => override.dayOfWeek)
  );
  const allDaysHaveOwnHours = (this.daysOfWeek || []).every((day) => daysCoveredByOverrides.has(day));

  if (!hasBaseShift && !this.label) {
    this.invalidate('label', 'label is required when there is no base shift');
  }

  if (!hasBaseShift && !hasGlobalHours && !hasGlobalSegments && !allDaysHaveOwnHours) {
    this.invalidate(
      'dayTimeOverrides',
      'Without a base shift, define global hours or provide hours for every selected day'
    );
  }
});

module.exports = mongoose.model('ShiftPattern', shiftPatternSchema);
