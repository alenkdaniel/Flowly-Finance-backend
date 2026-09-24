import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * FIXED DEPOSIT — self-contained; nothing about an FD needs its own child
 * collection (no unbounded sub-list), so it stays a single flat document.
 */
const fixedDepositSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    account: { type: Schema.Types.ObjectId, ref: "Account", required: true },
    principalAmount: { type: Number, required: true, min: 0 },
    interestRate: { type: Number, required: true },
    tenureMonths: { type: Number, required: true },

    // Customer-chosen FD details (captured on the "Enter FD Details" step)
    fdType: {
      type: String,
      enum: ["regular", "senior_citizen", "tax_saver", "special", "flexi"],
      default: "regular",
    },

    // Set when the customer picked a named FD scheme from the catalog
    // (FDScheme) rather than a bare fdType + tenure. schemeSnapshot freezes
    // the scheme's display details (name/code/badge) as they were at the
    // moment this FD was created, so a worker editing the scheme later never
    // silently changes what an existing customer sees on an already-opened FD.
    scheme: { type: Schema.Types.ObjectId, ref: "FDScheme" },
    schemeSnapshot: {
      name: String,
      code: String,
      category: String,
      badge: String,
    },
    interestPayoutOption: {
      type: String,
      enum: ["cumulative", "monthly", "quarterly", "annually"],
      default: "cumulative",
    },
    maturityInstruction: {
      type: String,
      enum: ["credit_to_savings", "renew_principal", "renew_principal_and_interest"],
      default: "credit_to_savings",
    },

    startDate: { type: Date, required: true },
    maturityDate: { type: Date, required: true },
    maturityAmount: { type: Number, required: true },
    // pending: submitted, awaiting worker review — nothing has been debited yet.
    // info_requested: worker asked the customer for more information; back to
    //   "pending" (re-review) once the customer resubmits.
    // rejected: worker declined the request — terminal, nothing was debited.
    // active: worker-approved, principal debited and FD is live.
    status: {
      type: String,
      enum: ["pending", "info_requested", "rejected", "active", "matured", "closed_early", "cancelled"],
      default: "pending",
      index: true,
    },
    certificateUrl: String,

    // Unique FD account number, assigned only once a worker approves the
    // request (mirrors how a savings Account gets its accountNumber).
    fdNumber: { type: String, unique: true, sparse: true, index: true },

    // Worker review trail (Worker Review -> Decision step of the FD flow)
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    rejectionReason: { type: String },

    // Snapshot of the rule-based AML/Fraud check shown on the worker review
    // screen, recorded so the flags a decision was made against stay on file.
    amlCheck: {
      riskLevel: { type: String, enum: ["low", "medium", "high"] },
      flags: [String],
      checkedAt: Date,
    },

    // "Request More Information" -> "Customer Uploads Information" loop.
    infoRequests: {
      type: [
        {
          message: { type: String, required: true },
          requestedBy: { type: Schema.Types.ObjectId, ref: "User" },
          requestedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    infoResponses: {
      type: [
        {
          note: String,
          documentUrl: String,
          document: { type: Schema.Types.ObjectId, ref: "Document" },
          submittedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    // Renewal chain — set when this FD was opened by auto/manual renewal of a matured FD,
    // and on the parent once it spawns a renewal.
    autoRenew: { type: Boolean, default: false },
    renewedFrom: { type: Schema.Types.ObjectId, ref: "FixedDeposit" },
    renewedTo: { type: Schema.Types.ObjectId, ref: "FixedDeposit" },

    // Set once the maturity job actually pays this FD out, so re-runs are idempotent.
    maturityProcessedAt: { type: Date },

    // Present only when status === "closed_early".
    earlyClosure: {
      closedAt: Date,
      elapsedMonths: Number,
      penaltyRate: Number, // percentage points shaved off the contracted rate
      effectiveRate: Number,
      interestPaid: Number,
      payoutAmount: Number,
    },
  },
  { timestamps: true }
);

fixedDepositSchema.index({ user: 1, status: 1 });
fixedDepositSchema.index({ maturityDate: 1, status: 1 }); // powers maturity-reminder job

export default mongoose.model("FixedDeposit", fixedDepositSchema);