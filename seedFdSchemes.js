/**
 * seedFDSchemes.js
 *
 * Populates the FD scheme catalog so customers see a list of named Fixed
 * Deposit products to choose from (GET /api/deposits/fd/schemes), the way a
 * real digital bank app does, instead of typing in a raw tenure + type.
 * Workers/admins can go on to edit these via PUT /api/deposits/fd/schemes/:id.
 *
 * Usage:
 *   node seedFDSchemes.js          # Seed default schemes if empty
 *   node seedFDSchemes.js --force  # Overwrite/re-seed existing schemes
 *   node seedFDSchemes.js --clean  # Remove all seeded schemes
 */

import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "./config/db.js";
import FDScheme from "./models/FdScheme.js";

const DEFAULT_FD_SCHEMES = [
  {
    name: "Flowly Regular FD",
    code: "REG-STD",
    description: "Our standard Fixed Deposit for any savings goal, 3 months to 10 years.",
    category: "regular",
    minTenureMonths: 3,
    maxTenureMonths: 120,
    interestRate: 6.25, // "starting from" — actual rate resolved via rateSlabs below
    rateSlabs: [
      { minMonths: 3, maxMonths: 5, rate: 5.5 },
      { minMonths: 6, maxMonths: 11, rate: 6.25 },
      { minMonths: 12, maxMonths: 23, rate: 7.0 },
      { minMonths: 24, maxMonths: 35, rate: 7.25 },
      { minMonths: 36, maxMonths: 59, rate: 7.4 },
      { minMonths: 60, maxMonths: 120, rate: 7.5 },
    ],
    minDeposit: 1000,
    maxDeposit: null,
    allowedPayoutOptions: ["cumulative", "monthly", "quarterly", "annually"],
    seniorCitizenOnly: false,
    seniorCitizenBonusRate: 0.5,
    badge: "",
    tags: [],
    isActive: true,
    sortOrder: 1,
  },
  {
    name: "Flowly 555 Days Special",
    code: "SPL-555",
    description: "A limited-period special FD with a boosted rate for a fixed 555-day tenure.",
    category: "special",
    minTenureMonths: 18,
    maxTenureMonths: 18, // ~555 days, modelled here in whole months
    interestRate: 7.75,
    rateSlabs: [],
    minDeposit: 5000,
    maxDeposit: 5000000,
    allowedPayoutOptions: ["cumulative"],
    seniorCitizenOnly: false,
    seniorCitizenBonusRate: 0.5,
    badge: "Highest Returns",
    tags: ["Limited Period"],
    isActive: true,
    sortOrder: 2,
  },
  {
    name: "Flowly Senior Citizen Special",
    code: "SR-CITIZEN",
    description: "Extra interest on every tenure, exclusively for customers aged 60 and above.",
    category: "senior_citizen",
    minTenureMonths: 6,
    maxTenureMonths: 120,
    interestRate: 7.75,
    rateSlabs: [
      { minMonths: 6, maxMonths: 11, rate: 6.75 },
      { minMonths: 12, maxMonths: 23, rate: 7.5 },
      { minMonths: 24, maxMonths: 59, rate: 7.75 },
      { minMonths: 60, maxMonths: 120, rate: 8.0 },
    ],
    minDeposit: 1000,
    maxDeposit: null,
    allowedPayoutOptions: ["cumulative", "monthly", "quarterly", "annually"],
    seniorCitizenOnly: true,
    seniorCitizenBonusRate: 0, // bonus already baked into the slabs above
    badge: "For 60+",
    tags: ["Senior Citizen"],
    isActive: true,
    sortOrder: 3,
  },
  {
    name: "Flowly Tax Saver FD",
    code: "TAX-SAVER",
    description: "5-year lock-in FD eligible for tax deduction under Section 80C.",
    category: "tax_saver",
    minTenureMonths: 60,
    maxTenureMonths: 60,
    interestRate: 7.1,
    rateSlabs: [],
    minDeposit: 1000,
    maxDeposit: 150000,
    allowedPayoutOptions: ["cumulative"],
    seniorCitizenOnly: false,
    seniorCitizenBonusRate: 0.5,
    badge: "Tax Benefit",
    tags: ["80C"],
    isActive: true,
    sortOrder: 4,
  },
  {
    name: "Flowly Short-Term Flexi FD",
    code: "FLEXI-ST",
    description: "A short, flexible FD for parking money for a few months with monthly payouts.",
    category: "flexi",
    minTenureMonths: 1,
    maxTenureMonths: 5,
    interestRate: 5.5,
    rateSlabs: [],
    minDeposit: 500,
    maxDeposit: 200000,
    allowedPayoutOptions: ["cumulative", "monthly"],
    seniorCitizenOnly: false,
    seniorCitizenBonusRate: 0.25,
    badge: "Most Popular",
    tags: ["Short Term"],
    isActive: true,
    sortOrder: 0,
  },
];

const isForce = process.argv.includes("--force");
const isClean = process.argv.includes("--clean");

async function seed() {
  await connectDB();

  const existingCount = await FDScheme.countDocuments();
  if (existingCount > 0 && !isForce) {
    console.log(
      `FD schemes already exist (${existingCount} found). Use --force to overwrite, or --clean to remove them.`
    );
    await mongoose.connection.close();
    return;
  }

  if (isForce) {
    await FDScheme.deleteMany({});
    console.log("Cleared existing FD schemes (--force).");
  }

  const created = await FDScheme.insertMany(DEFAULT_FD_SCHEMES);
  console.log(`\nSeeded ${created.length} FD schemes successfully:`);
  for (const s of created) {
    console.log(
      `  - [${s.category}] ${s.name} (${s.code}) | ${s.interestRate}%+ | ${s.minTenureMonths}-${s.maxTenureMonths} mo | min ₹${s.minDeposit} [ID: ${s._id}]`
    );
  }

  await mongoose.connection.close();
}

async function clean() {
  await connectDB();
  const res = await FDScheme.deleteMany({});
  console.log(`Removed ${res.deletedCount} FD schemes.`);
  await mongoose.connection.close();
}

(isClean ? clean() : seed()).catch((err) => {
  console.error("Seed FD schemes script failed:", err);
  process.exit(1);
});