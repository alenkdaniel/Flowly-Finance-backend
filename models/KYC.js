import mongoose from "mongoose";

const kycSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    document: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
    },

    dob: {
      type: String,
    },

    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
    },

    address: {
      type: String,
    },

    idType: {
      type: String,
      enum: ["aadhaar", "pan", "passport", "voter_id"],
      default: "aadhaar",
    },

    idNumber: {
      type: String,
    },

    // Primary ID document (the one matching idType) - kept for older clients
    documentUrl: {
      type: String,
    },

    // Cloudinary-backed KYC files
    panDocument: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
    },

    panUrl: {
      type: String,
    },

    aadhaarDocument: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
    },

    aadhaarUrl: {
      type: String,
    },

    selfieDocument: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
    },

    selfieUrl: {
      type: String,
    },

    extractedData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // OCR check of the uploaded PAN / Aadhaar image (advisory for the officer)
    ocr: {
      status: {
        type: String,
        enum: [
          "not_run",
          "processing",
          "matched",
          "mismatch",
          "unreadable",
          "skipped",
          "failed",
        ],
        default: "not_run",
      },
      extractedIdNumber: { type: String }, // Aadhaar is stored masked
      idNumberValid: { type: Boolean },
      extractedDob: { type: String },
      dobMatched: { type: Boolean },
      confidence: { type: Number },
      reason: { type: String },
      processedAt: { type: Date },
    },

    // Video KYC
    videoKycStatus: {
      type: String,
      enum: ["not_scheduled", "scheduled", "in_progress", "completed", "cancelled", "missed"],
      default: "not_scheduled",
    },

    videoKycSession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VideoKycSession",
    },

    verificationStatus: {
      type: String,
      enum: ["pending", "under_verification", "verified", "rejected"],
      default: "pending",
    },

    rejectionReason: {
      type: String,
      default: "",
    },

    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    verifiedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model("KYC", kycSchema);