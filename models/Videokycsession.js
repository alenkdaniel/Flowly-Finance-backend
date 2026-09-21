import mongoose from "mongoose";

const videoKycSessionSchema = new mongoose.Schema(
  {
    kyc: { type: mongoose.Schema.Types.ObjectId, ref: "KYC", required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // The officer (worker/admin) who will take the call
    officer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    scheduledAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 30 },

    status: {
      type: String,
      enum: ["scheduled", "in_progress", "completed", "cancelled", "missed"],
      default: "scheduled",
    },

    // Unguessable id, reserved for the WebRTC room
    roomId: { type: String, required: true, unique: true },

    notes: { type: String, default: "" },
    cancelReason: { type: String, default: "" },
    rescheduledCount: { type: Number, default: 0 },

    // Customer must agree before the call can be recorded
    recordingConsent: {
      given: { type: Boolean, default: false },
      at: { type: Date },
      ip: { type: String },
    },

    // Filled in by the officer during the call
    checklist: {
      faceVerified: { type: Boolean, default: false },
      documentVerified: { type: Boolean, default: false },
      livenessPassed: { type: Boolean, default: false },
      remarks: { type: String, default: "" },
    },

    // Audit trail of the liveness prompts the officer sent
    livenessChallenges: [
      {
        _id: false,
        id: String,
        type: { type: String },
        text: String,
        code: String,
        sentAt: { type: Date, default: Date.now },
      },
    ],

    recording: {
      url: { type: String },
      publicId: { type: String },
      resourceType: { type: String, default: "video" },
      durationSeconds: { type: Number },
      bytes: { type: Number },
      uploadedAt: { type: Date },
    },

    startedAt: { type: Date },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

// A KYC application can only have one live session at a time
videoKycSessionSchema.index(
  { kyc: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["scheduled", "in_progress"] } },
  }
);

export default mongoose.model("VideoKycSession", videoKycSessionSchema);