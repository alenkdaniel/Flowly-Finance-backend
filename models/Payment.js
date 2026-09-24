import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // What this payment is for. Only one of `loan` / `account` is populated,
    // matching `purpose`.
    purpose: {
      type: String,
      enum: ["loan_repayment", "account_topup"],
      default: "loan_repayment",
    },

    loan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LoanApplication",
    },

    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
    },

    amount: {
      type: Number,
      required: true,
    },

    paymentDate: {
      type: Date,
      default: Date.now,
    },

    paymentStatus: {
      type: String,
      enum: ["success", "failed", "pending"],
      default: "pending",
    },

    transactionReference: {
      type: String,
      unique: true,
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model("Payment", paymentSchema);