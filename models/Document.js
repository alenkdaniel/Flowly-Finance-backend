import mongoose from "mongoose";

const documentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    documentType: {
      type: String,
      enum: ["aadhaar", "pan", "selfie", "salary_slip", "bank_statement"],
      required: true,
    },

    // Cloudinary (signed) URL of the stored file
    fileUrl: {
      type: String,
      required: true,
    },

    // Cloudinary details - needed to delete/re-sign the file later
    publicId: {
      type: String,
    },

    resourceType: {
      type: String,
      default: "image",
    },

    storageProvider: {
      type: String,
      enum: ["cloudinary", "local", "external"],
      default: "cloudinary",
    },

    verificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected"],
      default: "pending",
    },
  },
  {
    timestamps: { createdAt: "uploadedAt", updatedAt: false },
  },
);

export default mongoose.model("Document", documentSchema);