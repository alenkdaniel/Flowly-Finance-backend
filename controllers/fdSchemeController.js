import mongoose from "mongoose";
import FDScheme from "../models/FdScheme.js";

const PAYOUT_OPTIONS = ["cumulative", "monthly", "quarterly", "annually"];
const CATEGORIES = ["regular", "senior_citizen", "tax_saver", "special", "flexi"];

/**
 * Shape + validate the create/update body once, shared by createScheme and
 * updateScheme so both apply the exact same rules.
 */
const parseSchemeInput = (body, { partial = false } = {}) => {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has("name")) {
    if (!body.name || !String(body.name).trim()) return { error: "name is required" };
    out.name = String(body.name).trim();
  }
  if (!partial || has("code")) {
    if (!body.code || !String(body.code).trim()) return { error: "code is required" };
    out.code = String(body.code).trim().toUpperCase();
  }
  if (has("description")) out.description = String(body.description || "").trim();

  if (!partial || has("category")) {
    const category = body.category || "regular";
    if (!CATEGORIES.includes(category)) {
      return { error: `category must be one of: ${CATEGORIES.join(", ")}` };
    }
    out.category = category;
  }

  if (!partial || has("minTenureMonths") || has("maxTenureMonths")) {
    const minTenureMonths = Number(body.minTenureMonths);
    const maxTenureMonths = Number(body.maxTenureMonths ?? body.minTenureMonths);
    if (!minTenureMonths || minTenureMonths <= 0) {
      return { error: "minTenureMonths must be a positive number" };
    }
    if (!maxTenureMonths || maxTenureMonths < minTenureMonths) {
      return { error: "maxTenureMonths must be >= minTenureMonths" };
    }
    out.minTenureMonths = minTenureMonths;
    out.maxTenureMonths = maxTenureMonths;
  }

  if (!partial || has("interestRate")) {
    const interestRate = Number(body.interestRate);
    if (interestRate === undefined || Number.isNaN(interestRate) || interestRate < 0) {
      return { error: "interestRate must be a non-negative number" };
    }
    out.interestRate = interestRate;
  }

  if (has("rateSlabs")) {
    if (!Array.isArray(body.rateSlabs)) {
      return { error: "rateSlabs must be an array of { minMonths, maxMonths, rate }" };
    }
    const slabs = [];
    for (const slab of body.rateSlabs) {
      const minMonths = Number(slab.minMonths);
      const maxMonths = Number(slab.maxMonths);
      const rate = Number(slab.rate);
      if (!minMonths || !maxMonths || maxMonths < minMonths || Number.isNaN(rate) || rate < 0) {
        return { error: "Each rate slab needs a valid minMonths, maxMonths (>= minMonths) and rate" };
      }
      slabs.push({ minMonths, maxMonths, rate });
    }
    out.rateSlabs = slabs;
  }

  if (has("minDeposit")) {
    const minDeposit = Number(body.minDeposit);
    if (Number.isNaN(minDeposit) || minDeposit < 0) return { error: "minDeposit must be a non-negative number" };
    out.minDeposit = minDeposit;
  }
  if (has("maxDeposit")) {
    if (body.maxDeposit === null || body.maxDeposit === "") {
      out.maxDeposit = null;
    } else {
      const maxDeposit = Number(body.maxDeposit);
      if (Number.isNaN(maxDeposit) || maxDeposit <= 0) return { error: "maxDeposit must be a positive number or null" };
      out.maxDeposit = maxDeposit;
    }
  }

  if (has("allowedPayoutOptions")) {
    if (!Array.isArray(body.allowedPayoutOptions) || body.allowedPayoutOptions.length === 0) {
      return { error: "allowedPayoutOptions must be a non-empty array" };
    }
    for (const opt of body.allowedPayoutOptions) {
      if (!PAYOUT_OPTIONS.includes(opt)) {
        return { error: `allowedPayoutOptions can only contain: ${PAYOUT_OPTIONS.join(", ")}` };
      }
    }
    out.allowedPayoutOptions = body.allowedPayoutOptions;
  }

  if (has("seniorCitizenOnly")) out.seniorCitizenOnly = Boolean(body.seniorCitizenOnly);
  if (has("seniorCitizenBonusRate")) {
    const rate = Number(body.seniorCitizenBonusRate);
    if (Number.isNaN(rate) || rate < 0) return { error: "seniorCitizenBonusRate must be a non-negative number" };
    out.seniorCitizenBonusRate = rate;
  }

  if (has("badge")) out.badge = String(body.badge || "").trim();
  if (has("tags")) out.tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
  if (has("isActive")) out.isActive = Boolean(body.isActive);
  if (has("sortOrder")) out.sortOrder = Number(body.sortOrder) || 0;

  if (out.minTenureMonths !== undefined && out.maxTenureMonths !== undefined) {
    if (out.minTenureMonths > out.maxTenureMonths) {
      return { error: "minTenureMonths cannot be greater than maxTenureMonths" };
    }
  }

  return { data: out };
};

/**
 * "Customer gets different FD schemes" — the browsable catalog, like a real
 * digital bank app's FD product list.
 * GET /api/deposits/fd/schemes
 */
export const listActiveSchemes = async (req, res) => {
  try {
    const schemes = await FDScheme.find({ isActive: true }).sort({ sortOrder: 1, interestRate: -1 });
    return res.status(200).json({ schemes });
  } catch (error) {
    return res.status(500).json({ message: "Failed to load FD schemes", error: error.message });
  }
};

/**
 * Worker/admin catalog management view — includes inactive/retired schemes.
 * GET /api/deposits/fd/schemes/all
 */
export const listAllSchemes = async (req, res) => {
  try {
    const schemes = await FDScheme.find().sort({ sortOrder: 1, createdAt: -1 });
    return res.status(200).json({ schemes });
  } catch (error) {
    return res.status(500).json({ message: "Failed to load FD schemes", error: error.message });
  }
};

/** GET /api/deposits/fd/schemes/:id */
export const getSchemeById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid scheme id" });
    }
    const scheme = await FDScheme.findById(id);
    if (!scheme) return res.status(404).json({ message: "FD scheme not found" });
    return res.status(200).json({ scheme });
  } catch (error) {
    return res.status(500).json({ message: "Failed to load FD scheme", error: error.message });
  }
};

/**
 * Worker/admin creates a new FD scheme (product) for the catalog.
 * POST /api/deposits/fd/schemes
 */
export const createScheme = async (req, res) => {
  try {
    const parsed = parseSchemeInput(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    const scheme = await FDScheme.create({
      ...parsed.data,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    return res.status(201).json({ message: "FD scheme created", scheme });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A scheme with that name or code already exists" });
    }
    return res.status(400).json({ message: "Failed to create FD scheme", error: error.message });
  }
};

/**
 * Worker/admin edits an existing FD scheme's features (rate, tenure range,
 * deposit limits, payout options, badge, etc).
 *
 * Editing a scheme NEVER touches FDs that were already created under its old
 * terms — those keep the interestRate + schemeSnapshot they were opened with
 * (see createFixedDeposit in depositController.js). Only FD requests
 * submitted after this edit see the new terms.
 * PUT /api/deposits/fd/schemes/:id
 */
export const updateScheme = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid scheme id" });
    }

    const parsed = parseSchemeInput(req.body, { partial: true });
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    if (Object.keys(parsed.data).length === 0) {
      return res.status(400).json({ message: "No valid fields to update" });
    }

    const scheme = await FDScheme.findByIdAndUpdate(
      id,
      { ...parsed.data, updatedBy: req.user._id },
      { new: true, runValidators: true }
    );
    if (!scheme) return res.status(404).json({ message: "FD scheme not found" });

    return res.status(200).json({ message: "FD scheme updated", scheme });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A scheme with that name or code already exists" });
    }
    return res.status(400).json({ message: "Failed to update FD scheme", error: error.message });
  }
};

/**
 * Soft delete — retiring a scheme (isActive: false) instead of a hard delete,
 * since past FDs still reference it via FixedDeposit.scheme. A retired
 * scheme stops appearing to customers but existing FDs are unaffected.
 * PATCH /api/deposits/fd/schemes/:id/toggle
 */
export const toggleSchemeActive = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid scheme id" });
    }
    const scheme = await FDScheme.findById(id);
    if (!scheme) return res.status(404).json({ message: "FD scheme not found" });

    scheme.isActive = !scheme.isActive;
    scheme.updatedBy = req.user._id;
    await scheme.save();

    return res.status(200).json({
      message: `FD scheme ${scheme.isActive ? "activated" : "deactivated"}`,
      scheme,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to toggle FD scheme", error: error.message });
  }
};