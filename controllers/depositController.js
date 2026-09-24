import mongoose from "mongoose";
import Account from "../models/Account.js";
import FixedDeposit from "../models/FixedDeposit.js";
import TransactionBucket from "../models/TransactionBucket.js";
import Notification from "../models/Notification.js";
import Settings from "../models/Settings.js";
import KYC from "../models/KYC.js";
import User from "../models/User.js";
import Document from "../models/Document.js";
import Payment from "../models/Payment.js";
import FDScheme from "../models/FdScheme.js";
import paymentGateway from "../services/paymentGateway.js";
import { uploadKycFile, uploadFDCertificate } from "../services/cloudinaryService.js";
import { generateFDCertificate } from "../utils/fdCertificateGenerator.js";
import { sendFDApprovalEmail } from "../utils/mailer.js";

export const FD_TYPES = ["regular", "senior_citizen", "tax_saver", "special", "flexi"];
export const FD_PAYOUT_OPTIONS = ["cumulative", "monthly", "quarterly", "annually"];
export const FD_MATURITY_INSTRUCTIONS = [
  "credit_to_savings",
  "renew_principal",
  "renew_principal_and_interest",
];

const recordTransaction = async ({
  accountId,
  userId,
  type,
  amount,
  description,
  refType,
  refId,
  meta = {},
}) => {
  return TransactionBucket.postEntry({
    accountId,
    userId,
    type,
    amount,
    description,
    refType,
    refId,
    meta,
  });
};

const notify = async ({ userId, title, message, type = "deposit" }) => {
  try {
    return await Notification.create({ user: userId, title, message, type });
  } catch (err) {
    // Notification failures should never break the money-movement flow.
    console.error("notify() failed:", err.message);
    return null;
  }
};

/**
 * "FD Certificate Generated" -> "SMS / Email / Notification" step, run right
 * after an FD is activated. Generates the certificate PDF, uploads it to
 * Cloudinary, persists the URL on the FD, and fires the customer email
 * (certificate attached) plus the in-app notification.
 *
 * Mirrors notify()'s philosophy: best-effort. Certificate/email delivery
 * problems are logged and swallowed rather than failing an approval that has
 * already moved money.
 */
const issueFDCertificateAndNotify = async (fd) => {
  let certificateUrl;

  try {
    const user = await User.findById(fd.user);
    const account = await Account.findById(fd.account);

    const pdfBuffer = await generateFDCertificate(fd, user, {
      accountNumber: account?.accountNumber,
    });

    const uploaded = await uploadFDCertificate(pdfBuffer, {
      userId: fd.user.toString(),
      fdNumber: fd.fdNumber,
    });
    certificateUrl = uploaded.url;

    await FixedDeposit.updateOne({ _id: fd._id }, { certificateUrl });

    if (user?.email) {
      await sendFDApprovalEmail(
        user.email,
        {
          userName: user.name,
          fdNumber: fd.fdNumber,
          principalAmount: fd.principalAmount,
          interestRate: fd.interestRate,
          tenureMonths: fd.tenureMonths,
          maturityDate: fd.maturityDate,
          maturityAmount: fd.maturityAmount,
          certificateUrl,
        },
        pdfBuffer
      );
    }
  } catch (err) {
    // Certificate generation, upload, or email failures should never
    // unwind an approval that has already debited funds — same contract
    // as notify() below.
    console.error("issueFDCertificateAndNotify() failed:", err.message);
  }

  // In-app Notification — always attempted, even if the certificate step above failed.
  await notify({
    userId: fd.user,
    title: "Fixed Deposit approved",
    message: certificateUrl
      ? `Your Fixed Deposit request of ₹${fd.principalAmount} has been approved and activated. FD Number: ${fd.fdNumber}. Your certificate has been emailed to you and is available in the app.`
      : `Your Fixed Deposit request of ₹${fd.principalAmount} has been approved and activated. FD Number: ${fd.fdNumber}.`,
  });

  return certificateUrl;
};

const getFDSettings = async () => {
  const settings = await Settings.findOne({ key: "global" });
  const values = settings?.values || {};
  return {
    minLockInMonths: Number(values.fdMinLockInMonths ?? 1),
    earlyClosurePenaltyRate: Number(values.fdEarlyClosurePenaltyRate ?? 1), // percentage points
  };
};

const calculateMaturityAmount = (principal, rate, months) => {
  const tYears = months / 12;
  return Math.round(principal * Math.pow(1 + rate / 400, 4 * tYears) * 100) / 100;
};

const monthsElapsed = (from, to) => {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
};

// Default tenure-wise rate card, used unless overridden via Settings ("global" ->
// values.fdRateSlabs = [{ minMonths, maxMonths, rate }, ...]). Kept in ascending
// order of minMonths; the first slab whose range contains the tenure wins.
const DEFAULT_FD_RATE_SLABS = [
  { minMonths: 1, maxMonths: 5, rate: 5.5 },
  { minMonths: 6, maxMonths: 11, rate: 6.25 },
  { minMonths: 12, maxMonths: 23, rate: 7.0 },
  { minMonths: 24, maxMonths: 35, rate: 7.25 },
  { minMonths: 36, maxMonths: 59, rate: 7.4 },
  { minMonths: 60, maxMonths: 120, rate: 7.5 },
];

/**
 * Interest rate is always derived server-side from tenure + FD type — never
 * trusted from the client — so a customer can't submit an inflated rate.
 */
const getFDRateCard = async () => {
  const settings = await Settings.findOne({ key: "global" });
  const values = settings?.values || {};
  return {
    slabs: Array.isArray(values.fdRateSlabs) && values.fdRateSlabs.length
      ? values.fdRateSlabs
      : DEFAULT_FD_RATE_SLABS,
    seniorCitizenBonusRate: Number(values.fdSeniorCitizenBonusRate ?? 0.5),
    taxSaverTenureMonths: Number(values.fdTaxSaverTenureMonths ?? 60),
    taxSaverRate: values.fdTaxSaverRate !== undefined ? Number(values.fdTaxSaverRate) : null,
  };
};

const resolveInterestRate = (tenureMonths, fdType, rateCard) => {
  if (fdType === "tax_saver" && rateCard.taxSaverRate !== null) {
    return rateCard.taxSaverRate;
  }

  const slab = rateCard.slabs.find(
    (s) => tenureMonths >= s.minMonths && tenureMonths <= s.maxMonths
  );
  let rate = slab ? slab.rate : rateCard.slabs[rateCard.slabs.length - 1].rate;

  if (fdType === "senior_citizen") {
    rate = Math.round((rate + rateCard.seniorCitizenBonusRate) * 100) / 100;
  }

  return rate;
};

/**
 * Resolve a scheme's interest rate for a given tenure, applying the senior
 * citizen bonus when the scheme grants one. Mirrors resolveInterestRate()'s
 * slab-matching logic, but sourced from the FDScheme document (the worker's
 * catalog entry) instead of the global Settings-based rate card.
 */
const resolveSchemeInterestRate = (scheme, tenureMonths, isSeniorCitizen) => {
  let rate;
  if (Array.isArray(scheme.rateSlabs) && scheme.rateSlabs.length > 0) {
    const slab = scheme.rateSlabs.find((s) => tenureMonths >= s.minMonths && tenureMonths <= s.maxMonths);
    rate = slab ? slab.rate : scheme.rateSlabs[scheme.rateSlabs.length - 1].rate;
  } else {
    rate = scheme.interestRate;
  }
  if (isSeniorCitizen && scheme.seniorCitizenBonusRate) {
    rate = Math.round((rate + scheme.seniorCitizenBonusRate) * 100) / 100;
  }
  return rate;
};

/**
 * "System Calculates" step — given the customer's FD details, derive the
 * interest rate, interest earned, maturity amount and maturity date.
 * For non-cumulative payout options, interest is paid out periodically as
 * simple interest instead of compounding into the maturity payout.
 *
 * When `scheme` is supplied (the customer picked a named FD scheme from the
 * catalog), the rate comes from that scheme's own rate card instead of the
 * global Settings-driven one — this is what lets a worker's edits to a
 * scheme's rate/features apply to new FD requests without touching the
 * legacy free-form fdType flow.
 */
const computeFDTerms = async ({ principal, fdType, tenureMonths, interestPayoutOption, startDate, scheme, isSeniorCitizen }) => {
  let interestRate;

  if (scheme) {
    interestRate = resolveSchemeInterestRate(scheme, tenureMonths, isSeniorCitizen);
  } else {
    if (fdType === "tax_saver") {
      const rateCard = await getFDRateCard();
      if (tenureMonths !== rateCard.taxSaverTenureMonths) {
        const err = new Error(
          `Tax Saver FDs must have a tenure of exactly ${rateCard.taxSaverTenureMonths} months.`
        );
        err.statusCode = 400;
        throw err;
      }
    }

    const rateCard = await getFDRateCard();
    interestRate = resolveInterestRate(tenureMonths, fdType, rateCard);
  }

  const start = startDate || new Date();
  const maturityDate = new Date(start);
  maturityDate.setMonth(maturityDate.getMonth() + tenureMonths);

  let maturityAmount;
  let totalInterestEarned;
  let payoutSchedule = null;

  if (interestPayoutOption === "cumulative") {
    maturityAmount = calculateMaturityAmount(principal, interestRate, tenureMonths);
    totalInterestEarned = Math.round((maturityAmount - principal) * 100) / 100;
  } else {
    // Non-cumulative: simple interest, paid out each period; principal alone
    // is returned at maturity.
    totalInterestEarned =
      Math.round(principal * (interestRate / 100) * (tenureMonths / 12) * 100) / 100;
    maturityAmount = principal;

    const periodsPerYear = { monthly: 12, quarterly: 4, annually: 1 }[interestPayoutOption];
    const numberOfPayouts = Math.max(1, Math.round((tenureMonths / 12) * periodsPerYear));
    payoutSchedule = {
      frequency: interestPayoutOption,
      numberOfPayouts,
      amountPerPayout: Math.round((totalInterestEarned / numberOfPayouts) * 100) / 100,
    };
  }

  return {
    fdType,
    interestPayoutOption,
    principalAmount: Math.round(principal * 100) / 100,
    interestRate,
    tenureMonths,
    startDate: start,
    maturityDate,
    totalInterestEarned,
    maturityAmount: Math.round(maturityAmount * 100) / 100,
    payoutSchedule,
  };
};

/**
 * FD eligibility: only KYC-approved customers with an active savings
 * account may view FD terms or open one. Returns { ok:false, status, message }
 * on failure, or { ok:true, account } on success.
 */
const checkFDEligibility = async (user) => {
  if (user.kycStatus !== "verified") {
    return {
      ok: false,
      status: 403,
      message: `KYC verification is required before you can open a Fixed Deposit. Current KYC status: '${user.kycStatus}'.`,
    };
  }

  if (user.status !== "active") {
    return {
      ok: false,
      status: 403,
      message: `Your account status is '${user.status}'. Fixed Deposits are available only to active accounts.`,
    };
  }

  const account = await Account.findOne({ user: user._id });
  if (!account) {
    return { ok: false, status: 404, message: "Bank account not found for user." };
  }

  if (account.status !== "active") {
    return {
      ok: false,
      status: 403,
      message: `Your savings account is '${account.status}'. Fixed Deposits require an active account.`,
    };
  }

  return { ok: true, account };
};

/**
 * Generates a customer-facing FD account number, e.g. "FD2026092312345678".
 * Collision odds are negligible (ms timestamp + random suffix), but the
 * unique index on FixedDeposit.fdNumber still guards against it — approve
 * retries on a duplicate-key error rather than trusting this blindly.
 */
const generateFDNumber = () => {
  const datePart = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `FD${datePart}${randomPart}`;
};

/**
 * Rule-based AML/fraud screen for the "AML/Fraud Checks" panel of the
 * worker review screen. There's no external AML provider wired up, so this
 * flags a handful of common red flags heuristically; a worker still makes
 * the actual call. Never blocks approval by itself.
 */
const runAMLFraudCheck = async ({ fixedDeposit, user, account }) => {
  const flags = [];

  const HIGH_VALUE_THRESHOLD = 1000000; // ₹10L+ gets extra scrutiny
  if (fixedDeposit.principalAmount >= HIGH_VALUE_THRESHOLD) {
    flags.push("High-value deposit (₹10,00,000 or more)");
  }

  const accountAgeDays = (Date.now() - new Date(account.createdAt).getTime()) / 86400000;
  if (accountAgeDays < 30) {
    flags.push("Savings account is less than 30 days old");
  }

  if (account.balance > 0 && fixedDeposit.principalAmount >= account.balance * 0.9) {
    flags.push("FD principal consumes 90%+ of the current account balance");
  }

  const [recentFDCount, kyc] = await Promise.all([
    FixedDeposit.countDocuments({
      user: user._id,
      createdAt: { $gte: new Date(Date.now() - 30 * 86400000) },
    }),
    KYC.findOne({ user: user._id }).select("verificationStatus ocr").lean(),
  ]);
  if (recentFDCount >= 3) {
    flags.push(`${recentFDCount} FD requests from this customer in the last 30 days`);
  }

  if (!kyc || kyc.verificationStatus !== "verified") {
    flags.push("KYC is not in a verified state");
  }
  if (kyc?.ocr?.status === "mismatch") {
    flags.push("KYC document OCR previously flagged a mismatch");
  }

  if (user.status !== "active") {
    flags.push(`Customer account status is '${user.status}'`);
  }

  const riskLevel = flags.length >= 3 ? "high" : flags.length >= 1 ? "medium" : "low";
  return { riskLevel, flags, checkedAt: new Date() };
};

/**
 * Recent ledger entries for one account, newest first — the "Transaction
 * History" panel of the worker review screen.
 */
const getAccountTransactionHistory = async (accountId, limit = 20) => {
  const entries = await TransactionBucket.aggregate([
    { $match: { account: new mongoose.Types.ObjectId(accountId) } },
    { $unwind: "$entries" },
    { $sort: { "entries.postedAt": -1 } },
    { $limit: limit },
    {
      $project: {
        _id: "$entries._id",
        type: "$entries.type",
        amount: "$entries.amount",
        description: "$entries.description",
        refType: "$entries.refType",
        refId: "$entries.refId",
        postedAt: "$entries.postedAt",
      },
    },
  ]);
  return entries;
};

const validateFDDetailsInput = ({ principalAmount, fdType, tenureMonths, interestPayoutOption, maturityInstruction }) => {
  const principal = Number(principalAmount);
  const months = Number(tenureMonths);
  const type = fdType || "regular";
  const payoutOption = interestPayoutOption || "cumulative";
  const instruction = maturityInstruction || "credit_to_savings";

  if (!principal || principal <= 0) {
    return { error: "Please provide a valid deposit amount greater than 0" };
  }
  if (!months || months <= 0) {
    return { error: "Please provide a valid tenure in months" };
  }
  if (!FD_TYPES.includes(type)) {
    return { error: `Invalid FD type. Must be one of: ${FD_TYPES.join(", ")}` };
  }
  if (!FD_PAYOUT_OPTIONS.includes(payoutOption)) {
    return { error: `Invalid interest payout option. Must be one of: ${FD_PAYOUT_OPTIONS.join(", ")}` };
  }
  if (!FD_MATURITY_INSTRUCTIONS.includes(instruction)) {
    return { error: `Invalid maturity instruction. Must be one of: ${FD_MATURITY_INSTRUCTIONS.join(", ")}` };
  }
  if (type === "senior_citizen") {
    return { principal, months, type, payoutOption, instruction, requiresAgeCheck: true };
  }

  return { principal, months, type, payoutOption, instruction, requiresAgeCheck: false };
};

/**
 * Look up + validate the FD scheme a customer picked from the catalog
 * (`schemeId` in the request body), enforcing that scheme's own tenure /
 * deposit / payout-option constraints. Returns { scheme: null } untouched
 * when no schemeId is given, so the legacy free-form fdType flow keeps
 * working exactly as before.
 */
const resolveRequestedScheme = async (schemeId) => {
  if (!schemeId) return { scheme: null };
  if (!mongoose.Types.ObjectId.isValid(schemeId)) {
    return { error: "Invalid schemeId", status: 400 };
  }
  const scheme = await FDScheme.findById(schemeId);
  if (!scheme || !scheme.isActive) {
    return { error: "This FD scheme is not available", status: 404 };
  }
  return { scheme };
};

const validateAgainstScheme = (scheme, { principal, months, payoutOption }) => {
  if (months < scheme.minTenureMonths || months > scheme.maxTenureMonths) {
    return {
      error: `"${scheme.name}" allows a tenure between ${scheme.minTenureMonths} and ${scheme.maxTenureMonths} months`,
    };
  }
  if (!scheme.allowedPayoutOptions.includes(payoutOption)) {
    return {
      error: `"${scheme.name}" only supports these interest payout options: ${scheme.allowedPayoutOptions.join(", ")}`,
    };
  }
  if (principal < scheme.minDeposit) {
    return { error: `"${scheme.name}" requires a minimum deposit of ₹${scheme.minDeposit}` };
  }
  if (scheme.maxDeposit && principal > scheme.maxDeposit) {
    return { error: `"${scheme.name}" allows a maximum deposit of ₹${scheme.maxDeposit}` };
  }
  return {};
};

const calculateAge = (dobString) => {
  const dob = new Date(dobString);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
};

/**
 * "Add Money" step of the FD flow — used when the Balance Check finds the
 * savings account short of the FD principal. Creates a Stripe PaymentIntent
 * and a matching pending Payment record; the actual credit happens once the
 * payment succeeds (via confirmAccountTopUp or the Stripe webhook), never
 * here, so nothing is credited on a request that never completes.
 * POST /api/deposits/account/topup/initiate
 */
export const initiateAccountTopUp = async (req, res) => {
  try {
    const eligibility = await checkFDEligibility(req.user);
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({ message: eligibility.message });
    }
    const { account } = eligibility;

    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({
        message: "Please provide a valid top-up amount greater than 0",
      });
    }

    const intent = await paymentGateway.createPaymentIntent({
      amountInRupees: amount,
      metadata: {
        purpose: "account_topup",
        userId: req.user._id.toString(),
        accountId: account._id.toString(),
      },
    });

    await Payment.create({
      user: req.user._id,
      account: account._id,
      purpose: "account_topup",
      amount,
      paymentStatus: "pending",
      transactionReference: intent.transactionId,
    });

    return res.status(201).json({
      message: "Top-up payment initiated. Complete the payment on the client, then confirm it.",
      clientSecret: intent.clientSecret,
      transactionId: intent.transactionId,
      amount,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to initiate top-up payment",
      error: error.message,
    });
  }
};

/**
 * Credits a top-up's amount to its linked account, exactly once. Shared by
 * the customer-facing confirm endpoint and the Stripe webhook so a payment
 * confirmed through either path (or both, in a race) is only ever applied
 * once — the status-guarded findOneAndUpdate is the idempotency guard.
 */
const creditAccountTopUp = async (payment) => {
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, paymentStatus: { $ne: "success" } },
    { paymentStatus: "success" },
    { new: true }
  );

  if (!claimed) {
    // Already credited by a previous confirm/webhook call.
    const account = await Account.findById(payment.account);
    return { alreadyProcessed: true, payment, account };
  }

  const account = await Account.findById(claimed.account);
  if (!account) {
    throw new Error("Linked account not found for top-up payment");
  }

  account.balance += claimed.amount;
  await account.save();

  await recordTransaction({
    accountId: account._id,
    userId: claimed.user,
    type: "credit",
    amount: claimed.amount,
    description: "Savings account top-up via card payment",
    refType: "Account",
    refId: account._id,
    meta: {
      category: "account_topup",
      balanceAfter: account.balance,
      paymentId: claimed._id,
      gatewayTransactionId: claimed.transactionReference,
    },
  });

  await notify({
    userId: claimed.user,
    title: "Money added to your account",
    message: `₹${claimed.amount} has been added to your savings account. New balance: ₹${account.balance}.`,
  });

  return { alreadyProcessed: false, payment: claimed, account };
};

/**
 * Called by the customer's client after Stripe confirms the card payment.
 * Verifies the PaymentIntent's actual status with Stripe before crediting
 * anything — the client's word alone is never trusted.
 * POST /api/deposits/account/topup/confirm
 */
export const confirmAccountTopUp = async (req, res) => {
  try {
    const { transactionId } = req.body;
    if (!transactionId) {
      return res.status(400).json({ message: "transactionId is required" });
    }

    const payment = await Payment.findOne({
      transactionReference: transactionId,
      user: req.user._id,
      purpose: "account_topup",
    });
    if (!payment) {
      return res.status(404).json({ message: "Top-up payment not found" });
    }

    if (payment.paymentStatus === "success") {
      const account = await Account.findById(payment.account);
      return res.status(200).json({
        message: "Payment already confirmed",
        accountBalance: account ? account.balance : undefined,
      });
    }

    const intent = await paymentGateway.retrievePaymentIntent(transactionId);
    if (intent.status !== "succeeded") {
      return res.status(400).json({
        message: `Payment has not completed yet (status: ${intent.status}). Try again once it succeeds.`,
      });
    }

    const result = await creditAccountTopUp(payment);
    return res.status(200).json({
      message: "Payment confirmed and account credited",
      accountBalance: result.account ? result.account.balance : undefined,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to confirm top-up payment",
      error: error.message,
    });
  }
};

/**
 * Stripe webhook entry point (called from repaymentController's shared
 * /api/webhooks/stripe handler when the PaymentIntent's metadata.purpose is
 * "account_topup"). Authoritative crediting path for production use.
 */
export const creditAccountTopUpFromIntent = async (intent) => {
  const payment = await Payment.findOne({
    transactionReference: intent.id,
    purpose: "account_topup",
  });
  if (!payment) {
    throw new Error(`No pending top-up payment found for PaymentIntent ${intent.id}`);
  }
  await creditAccountTopUp(payment);
};

export const depositFunds = async (req, res) => {
  try {
    const { amount, description = "Account deposit" } = req.body;
    const depositAmount = Number(amount);

    if (!depositAmount || depositAmount <= 0) {
      return res.status(400).json({
        message: "Please provide a valid deposit amount greater than 0",
      });
    }

    const account = await Account.findOne({ user: req.user._id });

    if (!account) {
      return res.status(404).json({
        message: "Bank account not found for this user",
      });
    }

    account.balance += depositAmount;
    await account.save();

    const txn = await recordTransaction({
      accountId: account._id,
      userId: req.user._id,
      type: "deposit",
      amount: depositAmount,
      description,
      meta: { category: "deposit", balanceAfter: account.balance },
    });

    return res.status(200).json({
      message: `Successfully deposited ₹${depositAmount} into savings account`,
      accountBalance: account.balance,
      transaction: txn,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Deposit failed",
      error: error.message,
    });
  }
};

/**
 * "Enter FD Details" → "System Calculates" step.
 * Given deposit amount, FD type, tenure, and interest payout option, returns
 * the system-derived interest rate, interest earned, maturity amount and
 * maturity date — WITHOUT touching the balance or creating anything.
 * Restricted to KYC-verified customers with an active account, since FDs
 * are only available to them end-to-end.
 * POST /api/deposits/fd/calculate
 */
export const calculateFixedDeposit = async (req, res) => {
  try {
    const eligibility = await checkFDEligibility(req.user);
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({ message: eligibility.message });
    }

    const schemeResult = await resolveRequestedScheme(req.body.schemeId);
    if (schemeResult.error) {
      return res.status(schemeResult.status).json({ message: schemeResult.error });
    }
    const { scheme } = schemeResult;

    const parsed = validateFDDetailsInput(
      scheme ? { ...req.body, fdType: req.body.fdType || scheme.category } : req.body
    );
    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }
    const { principal, months, type, payoutOption, instruction, requiresAgeCheck } = parsed;

    if (scheme) {
      const schemeCheck = validateAgainstScheme(scheme, { principal, months, payoutOption });
      if (schemeCheck.error) return res.status(400).json({ message: schemeCheck.error });
    }

    let isSeniorCitizen = false;
    if (requiresAgeCheck || scheme?.seniorCitizenOnly) {
      const kyc = await KYC.findOne({ user: req.user._id });
      const age = kyc?.dob ? calculateAge(kyc.dob) : null;
      isSeniorCitizen = age !== null && age >= 60;
      if (!isSeniorCitizen) {
        return res.status(400).json({
          message: scheme?.seniorCitizenOnly
            ? `"${scheme.name}" is available only to customers aged 60 and above.`
            : "Senior Citizen FDs are available only to customers aged 60 and above.",
        });
      }
    }

    const terms = await computeFDTerms({
      principal,
      fdType: type,
      tenureMonths: months,
      interestPayoutOption: payoutOption,
      scheme,
      isSeniorCitizen,
    });

    return res.status(200).json({
      message: "Fixed Deposit terms calculated successfully",
      calculation: {
        ...terms,
        maturityInstruction: instruction,
        scheme: scheme ? { id: scheme._id, name: scheme.name, code: scheme.code, badge: scheme.badge } : null,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Fixed Deposit calculation failed",
      error: error.statusCode ? undefined : error.message,
    });
  }
};

/**
 * Submit a Fixed Deposit request.
 * Restricted to KYC-verified customers with an active account. The interest
 * rate/maturity terms are always derived server-side (never from the
 * client). Balance Check: if the account can't cover the principal, this
 * returns 400 with code INSUFFICIENT_BALANCE and a shortfall amount instead
 * of creating anything — the client should route the customer through
 * /account/topup/initiate (Stripe) and retry this call once funded.
 * On success, nothing is debited yet: the FD is created with status
 * "pending" and sits in the worker queue. Debit + activation happen only
 * once a worker approves it (next step).
 * POST /api/deposits/fd/create
 */
export const createFixedDeposit = async (req, res) => {
  try {
    const eligibility = await checkFDEligibility(req.user);
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({ message: eligibility.message });
    }
    const { account } = eligibility;

    const schemeResult = await resolveRequestedScheme(req.body.schemeId);
    if (schemeResult.error) {
      return res.status(schemeResult.status).json({ message: schemeResult.error });
    }
    const { scheme } = schemeResult;

    const parsed = validateFDDetailsInput(
      scheme ? { ...req.body, fdType: req.body.fdType || scheme.category } : req.body
    );
    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }
    const { principal, months, type, payoutOption, instruction, requiresAgeCheck } = parsed;

    if (scheme) {
      const schemeCheck = validateAgainstScheme(scheme, { principal, months, payoutOption });
      if (schemeCheck.error) return res.status(400).json({ message: schemeCheck.error });
    }

    let isSeniorCitizen = false;
    if (requiresAgeCheck || scheme?.seniorCitizenOnly) {
      const kyc = await KYC.findOne({ user: req.user._id });
      const age = kyc?.dob ? calculateAge(kyc.dob) : null;
      isSeniorCitizen = age !== null && age >= 60;
      if (!isSeniorCitizen) {
        return res.status(400).json({
          message: scheme?.seniorCitizenOnly
            ? `"${scheme.name}" is available only to customers aged 60 and above.`
            : "Senior Citizen FDs are available only to customers aged 60 and above.",
        });
      }
    }

    const terms = await computeFDTerms({
      principal,
      fdType: type,
      tenureMonths: months,
      interestPayoutOption: payoutOption,
      scheme,
      isSeniorCitizen,
    });

    // Balance Check
    if (account.balance < principal) {
      const shortfall = Math.round((principal - account.balance) * 100) / 100;
      return res.status(400).json({
        message: `Insufficient account balance (₹${account.balance}). Add ₹${shortfall} more to submit this FD request.`,
        code: "INSUFFICIENT_BALANCE",
        accountBalance: account.balance,
        requiredAmount: principal,
        shortfall,
      });
    }

    // Balance is sufficient — submit the request. No debit yet: that happens
    // only once a worker approves it and Core Banking validates the FD.
    const fixedDeposit = await FixedDeposit.create({
      user: req.user._id,
      account: account._id,
      principalAmount: principal,
      interestRate: terms.interestRate,
      tenureMonths: months,
      fdType: type,
      interestPayoutOption: payoutOption,
      maturityInstruction: instruction,
      startDate: terms.startDate,
      maturityDate: terms.maturityDate,
      maturityAmount: terms.maturityAmount,
      status: "pending",
      autoRenew: instruction !== "credit_to_savings",
      scheme: scheme?._id,
      schemeSnapshot: scheme
        ? { name: scheme.name, code: scheme.code, category: scheme.category, badge: scheme.badge }
        : undefined,
    });

    await notify({
      userId: req.user._id,
      title: "Fixed Deposit request submitted",
      message: `Your FD request of ₹${principal} for ${months} months has been submitted and is pending review. You'll be notified once it's approved.`,
    });

    return res.status(201).json({
      message: "Fixed Deposit request submitted successfully and is pending review",
      fixedDeposit,
      accountBalance: account.balance,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Fixed Deposit request failed",
      error: error.statusCode ? undefined : error.message,
    });
  }
};

/**
 * Get a single Fixed Deposit owned by the requesting user
 * GET /api/deposits/fd/:id
 */
export const getFixedDepositById = async (req, res) => {
  try {
    const fixedDeposit = await FixedDeposit.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!fixedDeposit) {
      return res.status(404).json({ message: "Fixed Deposit not found" });
    }

    return res.status(200).json({ fixedDeposit });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to fetch Fixed Deposit",
      error: error.message,
    });
  }
};

/**
 * Close an active Fixed Deposit before its maturity date.
 * Applies a lock-in check and a penalty on the contracted rate, then pays
 * out principal + simple interest for the period actually held.
 * POST /api/deposits/fd/:id/close
 */
export const closeFixedDepositEarly = async (req, res) => {
  try {
    const fixedDeposit = await FixedDeposit.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!fixedDeposit) {
      return res.status(404).json({ message: "Fixed Deposit not found" });
    }

    if (fixedDeposit.status !== "active") {
      return res.status(400).json({
        message: `This Fixed Deposit is already ${fixedDeposit.status.replace("_", " ")} and cannot be closed again.`,
      });
    }

    const now = new Date();
    const elapsedMonths = monthsElapsed(fixedDeposit.startDate, now);
    const { minLockInMonths, earlyClosurePenaltyRate } = await getFDSettings();

    if (elapsedMonths < minLockInMonths) {
      return res.status(400).json({
        message: `This FD is within its lock-in period. Early closure is allowed only after ${minLockInMonths} month(s); ${elapsedMonths} month(s) have elapsed so far.`,
      });
    }

    const effectiveRate = Math.max(0, fixedDeposit.interestRate - earlyClosurePenaltyRate);
    const interestPaid = Math.round(
      fixedDeposit.principalAmount * (effectiveRate / 100) * (elapsedMonths / 12) * 100
    ) / 100;
    const payoutAmount = Math.round((fixedDeposit.principalAmount + interestPaid) * 100) / 100;

    // Atomically claim the FD so a concurrent maturity-job run can't also process it.
    const claimed = await FixedDeposit.findOneAndUpdate(
      { _id: fixedDeposit._id, status: "active" },
      {
        status: "closed_early",
        earlyClosure: {
          closedAt: now,
          elapsedMonths,
          penaltyRate: earlyClosurePenaltyRate,
          effectiveRate,
          interestPaid,
          payoutAmount,
        },
      },
      { new: true }
    );

    if (!claimed) {
      return res.status(409).json({
        message: "This Fixed Deposit was just processed (matured or closed) — please refresh and try again.",
      });
    }

    const account = await Account.findById(fixedDeposit.account);
    account.balance += payoutAmount;
    await account.save();

    const txn = await recordTransaction({
      accountId: account._id,
      userId: req.user._id,
      type: "credit",
      amount: payoutAmount,
      description: `Fixed Deposit closed early (${elapsedMonths} months held, ${effectiveRate}% effective rate)`,
      refType: "FixedDeposit",
      refId: claimed._id,
      meta: {
        category: "fd_early_closure",
        principal: fixedDeposit.principalAmount,
        interestPaid,
        penaltyRate: earlyClosurePenaltyRate,
        balanceAfter: account.balance,
      },
    });

    await notify({
      userId: req.user._id,
      title: "Fixed Deposit closed early",
      message: `Your FD of ₹${fixedDeposit.principalAmount} was closed early after ${elapsedMonths} month(s). ₹${payoutAmount} (incl. ₹${interestPaid} interest, after penalty) has been credited to your account.`,
    });

    return res.status(200).json({
      message: "Fixed Deposit closed successfully",
      fixedDeposit: claimed,
      accountBalance: account.balance,
      transaction: txn,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Fixed Deposit closure failed",
      error: error.message,
    });
  }
};

/**
 * Process every Fixed Deposit that has reached its maturity date and is
 * still "active". For each one: pay out principal + interest to the linked
 * savings account (or roll it into a fresh FD when autoRenew is set),
 * record the ledger entry, and notify the customer.
 *
 * Idempotent and safe to run concurrently / repeatedly — each FD is claimed
 * with an atomic status-guarded update before anything else touches it.
 * Called by the daily fdMaturityJob, and exposed to admins/workers via
 * POST /api/deposits/fd/process-maturity for manual/on-demand runs.
 */
export const processMaturedDeposits = async () => {
  const now = new Date();
  const dueDeposits = await FixedDeposit.find({
    status: "active",
    maturityDate: { $lte: now },
  });

  let processed = 0;
  let renewed = 0;
  const errors = [];

  for (const fd of dueDeposits) {
    try {
      const claimed = await FixedDeposit.findOneAndUpdate(
        { _id: fd._id, status: "active" },
        { status: "matured", maturityProcessedAt: now },
        { new: true }
      );

      if (!claimed) continue; // already handled by another run

      const account = await Account.findById(claimed.account);
      if (!account) {
        errors.push({ fixedDepositId: claimed._id, error: "Linked account not found" });
        continue;
      }

      if (claimed.autoRenew) {
        // Reinvest the payout into a brand-new FD instead of crediting the
        // savings balance, so the customer keeps compounding automatically.
        const newStartDate = now;
        const newMaturityDate = new Date(now);
        newMaturityDate.setMonth(newMaturityDate.getMonth() + claimed.tenureMonths);
        const newMaturityAmount = calculateMaturityAmount(
          claimed.maturityAmount,
          claimed.interestRate,
          claimed.tenureMonths
        );

        const renewedFD = await FixedDeposit.create({
          user: claimed.user,
          account: claimed.account,
          principalAmount: claimed.maturityAmount,
          interestRate: claimed.interestRate,
          tenureMonths: claimed.tenureMonths,
          startDate: newStartDate,
          maturityDate: newMaturityDate,
          maturityAmount: newMaturityAmount,
          status: "active",
          autoRenew: true,
          renewedFrom: claimed._id,
        });

        claimed.renewedTo = renewedFD._id;
        await claimed.save();

        await recordTransaction({
          accountId: account._id,
          userId: claimed.user,
          type: "credit",
          amount: claimed.maturityAmount,
          description: `Fixed Deposit matured and auto-renewed for ${claimed.tenureMonths} months`,
          refType: "FixedDeposit",
          refId: renewedFD._id,
          meta: { category: "fd_renewal", balanceAffected: false, renewedFrom: claimed._id },
        });

        await notify({
          userId: claimed.user,
          title: "Fixed Deposit renewed",
          message: `Your FD of ₹${claimed.principalAmount} matured at ₹${claimed.maturityAmount} and has been auto-renewed for ${claimed.tenureMonths} more months, maturing ${newMaturityDate.toDateString()}.`,
        });

        renewed += 1;
      } else {
        account.balance += claimed.maturityAmount;
        await account.save();

        await recordTransaction({
          accountId: account._id,
          userId: claimed.user,
          type: "credit",
          amount: claimed.maturityAmount,
          description: `Fixed Deposit matured (${claimed.tenureMonths} months @ ${claimed.interestRate}%)`,
          refType: "FixedDeposit",
          refId: claimed._id,
          meta: { category: "fd_maturity", balanceAfter: account.balance },
        });

        await notify({
          userId: claimed.user,
          title: "Fixed Deposit matured",
          message: `Your FD of ₹${claimed.principalAmount} has matured. ₹${claimed.maturityAmount} has been credited to your account.`,
        });
      }

      processed += 1;
    } catch (err) {
      errors.push({ fixedDepositId: fd._id, error: err.message });
    }
  }

  return { checked: dueDeposits.length, processed, renewed, errors };
};

/**
 * Manually trigger the maturity sweep on demand.
 * POST /api/deposits/fd/process-maturity
 * Access: worker, admin
 */
export const triggerFDMaturityCheck = async (req, res) => {
  try {
    const result = await processMaturedDeposits();
    return res.status(200).json({
      message: "Fixed Deposit maturity check completed",
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Fixed Deposit maturity check failed",
      error: error.message,
    });
  }
};

/**
 * Get User's Account Balance and Fixed Deposits
 * GET /api/deposits/my-deposits
 */
export const getUserDeposits = async (req, res) => {
  try {
    const account = await Account.findOne({ user: req.user._id });
    const fixedDeposits = await FixedDeposit.find({ user: req.user._id }).sort({ createdAt: -1 });

    return res.status(200).json({
      accountBalance: account ? account.balance : 0,
      accountNumber: account ? account.accountNumber : null,
      fixedDepositsCount: fixedDeposits.length,
      fixedDeposits,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to fetch deposits",
      error: error.message,
    });
  }
};

/* ------------------------------------------------------------------------ *
 * WORKER SIDE — FD review queue + decision (approve / reject / info-request)
 * ------------------------------------------------------------------------ */

/**
 * "Worker Queue" — FD requests waiting on a decision, oldest first so the
 * queue is worked in order. Includes both fresh submissions ("pending") and
 * ones a customer has just responded to after an info request, since those
 * re-enter as "pending" too.
 * GET /api/deposits/fd/queue
 * Access: worker, admin
 */
export const getFDWorkerQueue = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const skip = (page - 1) * limit;

    const allowedStatuses = ["pending", "info_requested"];
    const status = allowedStatuses.includes(req.query.status) ? req.query.status : "pending";

    const filter = { status };

    const [deposits, total] = await Promise.all([
      FixedDeposit.find(filter)
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email phone kycStatus status")
        .lean(),
      FixedDeposit.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit) || 0;

    return res.status(200).json({
      message: "Fixed Deposit worker queue fetched successfully",
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      fixedDeposits: deposits,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to fetch Fixed Deposit worker queue",
      error: error.message,
    });
  }
};

/**
 * "Worker Review" screen — everything a worker needs on one call: Customer
 * Profile, Account Status, Transaction History, AML/Fraud Checks, and the
 * FD Details themselves. Also (re)computes and snapshots the AML/fraud
 * check onto the FD, so the flags a worker acted on stay on record.
 * GET /api/deposits/fd/:id/review
 * Access: worker, admin
 */
export const getFDReviewDetails = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid Fixed Deposit id" });
    }

    const fixedDeposit = await FixedDeposit.findById(id);
    if (!fixedDeposit) {
      return res.status(404).json({ message: "Fixed Deposit not found" });
    }

    const [user, account] = await Promise.all([
      User.findById(fixedDeposit.user).select("-password -mpinHash -mpinHistory").lean(),
      Account.findById(fixedDeposit.account).lean(),
    ]);
    if (!user) return res.status(404).json({ message: "Customer not found" });
    if (!account) return res.status(404).json({ message: "Linked account not found" });

    const [kyc, transactionHistory, amlCheck] = await Promise.all([
      KYC.findOne({ user: user._id }).lean(),
      getAccountTransactionHistory(account._id),
      runAMLFraudCheck({ fixedDeposit, user, account }),
    ]);

    // Snapshot the check onto the FD so the flags a decision was made against are on record.
    fixedDeposit.amlCheck = amlCheck;
    await fixedDeposit.save();

    return res.status(200).json({
      message: "Fixed Deposit review details fetched successfully",
      fixedDeposit,
      customerProfile: user,
      accountStatus: {
        accountNumber: account.accountNumber,
        accountType: account.accountType,
        balance: account.balance,
        status: account.status,
        openedAt: account.createdAt,
      },
      transactionHistory,
      amlFraudCheck: amlCheck,
      kycSummary: kyc
        ? {
            verificationStatus: kyc.verificationStatus,
            idType: kyc.idType,
            ocrStatus: kyc.ocr?.status,
            videoKycStatus: kyc.videoKycStatus,
          }
        : null,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to fetch Fixed Deposit review details",
      error: error.message,
    });
  }
};

/**
 * Decision: Approve.
 * Core Banking Validation (account still active + still enough balance) ->
 * Savings Account Debit -> Internal Transfer (ledger entry) -> FD Account
 * activation with a generated FD Number. Fully atomic against double
 * approval or a race with the maturity job via the status-guarded claim.
 * POST /api/deposits/fd/:id/approve
 * Access: worker, admin
 */
export const approveFixedDeposit = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid Fixed Deposit id" });
    }

    const fixedDeposit = await FixedDeposit.findById(id);
    if (!fixedDeposit) {
      return res.status(404).json({ message: "Fixed Deposit not found" });
    }
    if (fixedDeposit.status !== "pending") {
      return res.status(400).json({
        message: `This Fixed Deposit is '${fixedDeposit.status.replace("_", " ")}' and cannot be approved.`,
      });
    }

    // Core Banking Validation — re-check everything at decision time, since
    // the balance/account state may have moved since the request was submitted.
    const account = await Account.findById(fixedDeposit.account);
    if (!account) {
      return res.status(404).json({ message: "Linked account not found" });
    }
    if (account.status !== "active") {
      return res.status(400).json({
        message: `Core Banking Validation failed: savings account is '${account.status}'.`,
      });
    }
    if (account.balance < fixedDeposit.principalAmount) {
      const shortfall = Math.round((fixedDeposit.principalAmount - account.balance) * 100) / 100;
      return res.status(400).json({
        message: `Core Banking Validation failed: insufficient balance (₹${account.balance}).`,
        code: "INSUFFICIENT_BALANCE",
        accountBalance: account.balance,
        requiredAmount: fixedDeposit.principalAmount,
        shortfall,
      });
    }

    const fdNumber = generateFDNumber();

    // Atomically claim the FD — guards against double-approval / concurrent decisions.
    const claimed = await FixedDeposit.findOneAndUpdate(
      { _id: fixedDeposit._id, status: "pending" },
      {
        status: "active",
        fdNumber,
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
      },
      { new: true }
    );
    if (!claimed) {
      return res.status(409).json({
        message: "This Fixed Deposit was just processed by another decision — please refresh and try again.",
      });
    }

    // Savings Account Debit
    account.balance -= claimed.principalAmount;
    await account.save();

    // Internal Transfer — ledger entry moving the principal into the FD.
    const txn = await recordTransaction({
      accountId: account._id,
      userId: claimed.user,
      type: "debit",
      amount: claimed.principalAmount,
      description: `Fixed Deposit ${claimed.fdNumber} opened — transferred from savings`,
      refType: "FixedDeposit",
      refId: claimed._id,
      meta: {
        category: "fd_booking",
        fdNumber: claimed.fdNumber,
        approvedBy: req.user._id.toString(),
        balanceAfter: account.balance,
      },
    });

    // FD Activated -> FD Certificate Generated -> SMS / Email / Notification
    const certificateUrl = await issueFDCertificateAndNotify(claimed);
    if (certificateUrl) claimed.certificateUrl = certificateUrl;

    return res.status(200).json({
      message: "Fixed Deposit approved and activated",
      fixedDeposit: claimed,
      accountBalance: account.balance,
      transaction: txn,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Fixed Deposit approval failed",
      error: error.message,
    });
  }
};

/**
 * Decision: Reject.
 * Nothing was ever debited for a pending FD, so rejection is a pure status
 * change plus a customer notification with the reason.
 * POST /api/deposits/fd/:id/reject   body: { reason }
 * Access: worker, admin
 */
export const rejectFixedDeposit = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid Fixed Deposit id" });
    }

    const reason = (req.body.reason || "").trim();
    if (!reason) {
      return res.status(400).json({ message: "A rejection reason is required" });
    }

    const fixedDeposit = await FixedDeposit.findById(id);
    if (!fixedDeposit) {
      return res.status(404).json({ message: "Fixed Deposit not found" });
    }
    if (fixedDeposit.status !== "pending") {
      return res.status(400).json({
        message: `This Fixed Deposit is '${fixedDeposit.status.replace("_", " ")}' and cannot be rejected.`,
      });
    }

    const claimed = await FixedDeposit.findOneAndUpdate(
      { _id: fixedDeposit._id, status: "pending" },
      {
        status: "rejected",
        rejectionReason: reason,
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
      },
      { new: true }
    );
    if (!claimed) {
      return res.status(409).json({
        message: "This Fixed Deposit was just processed by another decision — please refresh and try again.",
      });
    }

    // Customer Notification
    await notify({
      userId: claimed.user,
      title: "Fixed Deposit request rejected",
      message: `Your Fixed Deposit request of ₹${claimed.principalAmount} was rejected. Reason: ${reason}`,
    });

    return res.status(200).json({
      message: "Fixed Deposit rejected",
      fixedDeposit: claimed,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Fixed Deposit rejection failed",
      error: error.message,
    });
  }
};

/**
 * Decision: Request More Information.
 * Parks the FD on the customer's side until they respond via
 * submitFDAdditionalInfo, which puts it back in the worker queue.
 * POST /api/deposits/fd/:id/request-info   body: { message }
 * Access: worker, admin
 */
export const requestFDMoreInformation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid Fixed Deposit id" });
    }

    const message = (req.body.message || "").trim();
    if (!message) {
      return res.status(400).json({ message: "A message describing what's needed is required" });
    }

    const fixedDeposit = await FixedDeposit.findById(id);
    if (!fixedDeposit) {
      return res.status(404).json({ message: "Fixed Deposit not found" });
    }
    if (fixedDeposit.status !== "pending") {
      return res.status(400).json({
        message: `This Fixed Deposit is '${fixedDeposit.status.replace("_", " ")}'; more information can only be requested while it's pending review.`,
      });
    }

    const claimed = await FixedDeposit.findOneAndUpdate(
      { _id: fixedDeposit._id, status: "pending" },
      {
        status: "info_requested",
        reviewedBy: req.user._id,
        reviewedAt: new Date(),
        $push: { infoRequests: { message, requestedBy: req.user._id, requestedAt: new Date() } },
      },
      { new: true }
    );
    if (!claimed) {
      return res.status(409).json({
        message: "This Fixed Deposit was just processed by another decision — please refresh and try again.",
      });
    }

    await notify({
      userId: claimed.user,
      title: "More information needed for your Fixed Deposit request",
      message,
    });

    return res.status(200).json({
      message: "Information request sent to the customer",
      fixedDeposit: claimed,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to send information request",
      error: error.message,
    });
  }
};

/* ------------------------------------------------------------------------ *
 * Customer side of the info-request loop — needed to close the "Request
 * More Information" -> "Customer Uploads Information" -> "Re-Review" cycle.
 * ------------------------------------------------------------------------ */

/**
 * "Customer Uploads Information" — a customer responds to a worker's info
 * request with a note and/or a supporting document. Puts the FD straight
 * back into the worker queue ("Re-Review") as "pending".
 * POST /api/deposits/fd/:id/submit-info   multipart: note, document (file, optional)
 * Access: customer
 */
export const submitFDAdditionalInfo = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid Fixed Deposit id" });
    }

    const note = (req.body.note || "").trim();
    const file = req.file;
    if (!note && !file) {
      return res.status(400).json({ message: "Provide a note, a document, or both" });
    }

    const fixedDeposit = await FixedDeposit.findOne({ _id: id, user: req.user._id });
    if (!fixedDeposit) {
      return res.status(404).json({ message: "Fixed Deposit not found" });
    }
    if (fixedDeposit.status !== "info_requested") {
      return res.status(400).json({
        message: "This Fixed Deposit is not currently awaiting additional information",
      });
    }

    let document = null;
    if (file) {
      const uploaded = await uploadKycFile(file.buffer, { userId: req.user._id, kind: "document" });
      document = await Document.create({
        user: req.user._id,
        documentType: "bank_statement",
        fileUrl: uploaded.url,
        publicId: uploaded.publicId,
        resourceType: uploaded.resourceType,
      });
    }

    const claimed = await FixedDeposit.findOneAndUpdate(
      { _id: fixedDeposit._id, status: "info_requested" },
      {
        status: "pending",
        $push: {
          infoResponses: {
            note: note || undefined,
            documentUrl: document?.fileUrl,
            document: document?._id,
            submittedAt: new Date(),
          },
        },
      },
      { new: true }
    );
    if (!claimed) {
      return res.status(409).json({
        message: "This request was already updated — please refresh and try again.",
      });
    }

    return res.status(200).json({
      message: "Information submitted — your Fixed Deposit request is back in review",
      fixedDeposit: claimed,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to submit additional information",
      error: error.message,
    });
  }
};