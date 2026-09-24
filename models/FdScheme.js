import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * FD SCHEME — the bank's catalog of named Fixed Deposit products, the way a
 * real digital bank app shows a list of FD "plans" to choose from (e.g.
 * "Regular FD", "Tax Saver FD", "Senior Citizen Special", "555 Days Special")
 * instead of a customer typing in a raw tenure + type.
 *
 * A worker/admin manages this catalog (create / edit / retire schemes). A
 * scheme's terms are snapshotted onto each FixedDeposit at creation time
 * (FixedDeposit.schemeSnapshot), so editing a scheme later never changes the
 * terms of FDs customers already opened under the old terms — only future
 * FD requests pick up the change.
 */
const rateSlabSchema = new Schema(
  {
    minMonths: { type: Number, required: true, min: 1 },
    maxMonths: { type: Number, required: true, min: 1 },
    rate: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const fdSchemeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    // Short unique slug, e.g. "REG-12", "TAX-SAVER", "SR-CITIZEN-SPL", "FLEXI-555"
    code: { type: String, required: true, trim: true, uppercase: true, unique: true },
    description: { type: String, trim: true, default: "" },

    // Loosely mirrors FixedDeposit.fdType, but a scheme can also be a
    // bank-style promotional/special product that isn't one of the three
    // legacy types.
    category: {
      type: String,
      enum: ["regular", "senior_citizen", "tax_saver", "special", "flexi"],
      default: "regular",
    },

    // Tenure window this scheme is offered for. A "fixed tenure" scheme
    // (e.g. "555 Days Special") just sets minTenureMonths === maxTenureMonths.
    minTenureMonths: { type: Number, required: true, min: 1 },
    maxTenureMonths: { type: Number, required: true, min: 1 },

    // Flat base rate, used directly if rateSlabs is empty. If rateSlabs is
    // given, it takes priority and interestRate becomes just a display
    // "starting from" figure on the scheme-listing card.
    interestRate: { type: Number, required: true, min: 0 },
    rateSlabs: { type: [rateSlabSchema], default: [] },

    minDeposit: { type: Number, default: 1000, min: 0 },
    maxDeposit: { type: Number, default: null }, // null = no cap

    allowedPayoutOptions: {
      type: [String],
      enum: ["cumulative", "monthly", "quarterly", "annually"],
      default: ["cumulative", "monthly", "quarterly", "annually"],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0,
        message: "A scheme must allow at least one interest payout option",
      },
    },

    seniorCitizenOnly: { type: Boolean, default: false },
    seniorCitizenBonusRate: { type: Number, default: 0, min: 0 },

    // Display-only extras for a bank-app-style scheme listing card.
    badge: { type: String, trim: true, default: "" }, // e.g. "Most Popular", "Highest Returns"
    tags: { type: [String], default: [] }, // e.g. ["Tax Benefit", "80C"]

    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },

    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

fdSchemeSchema.index({ isActive: 1, sortOrder: 1 });

fdSchemeSchema.pre("validate", function () {
  if (this.minTenureMonths > this.maxTenureMonths) {
    throw new Error("minTenureMonths cannot be greater than maxTenureMonths");
  }
  for (const slab of this.rateSlabs) {
    if (slab.minMonths > slab.maxMonths) {
      throw new Error("Each rate slab's minMonths must be <= maxMonths");
    }
  }
});

export default mongoose.model("FDScheme", fdSchemeSchema);