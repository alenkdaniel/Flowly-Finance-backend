import KYC from "../models/KYC.js";
import User from "../models/User.js";
import Document from "../models/Document.js";
import Account from "../models/Account.js";
import { createBankAccountForUser } from "./authController.js";
import { sendNotification } from "./notificationController.js";
import { uploadKycFile, deleteKycFile } from "../services/cloudinaryService.js";
import VideoKycSession from "../models/VideoKycSession.js";
import { evaluateVideoKyc } from "../utils/videoKycRules.js";
import {
  runKycOcrInBackground,
  isOcrEligible,
} from "../services/ocrService.js";

// Every Document attached to a KYC submission (ID doc, PAN, Aadhaar, selfie)
const kycDocumentIds = (record) =>
  [
    record.document,
    record.panDocument,
    record.aadhaarDocument,
    record.selfieDocument,
  ].filter(Boolean);

const DOCUMENT_POPULATE_FIELDS = "documentType fileUrl uploadedAt verificationStatus";

export const submitKYC = async (req, res) => {
  const uploaded = []; // Cloudinary assets created by this request (for cleanup)

  try {
    const { dob, gender, address, idType, idNumber } = req.body;

    if (!address || !idType || !idNumber) {
      return res.status(400).json({
        message: "Please provide address, idType, and idNumber",
      });
    }

    const files = req.files || {};
    const selfieFile = files.selfie?.[0];
    const panFile = files.pan?.[0];
    const aadhaarFile = files.aadhaar?.[0];
    // "document" is the legacy single-file field; "pan"/"aadhaar" are the new ones
    const legacyFile = files.document?.[0];

    // The file that proves the chosen idType
    const primaryIdFile =
      legacyFile ||
      (idType === "pan" ? panFile : idType === "aadhaar" ? aadhaarFile : undefined);

    if (!primaryIdFile) {
      return res.status(400).json({
        message: `Please upload your ${idType} document (form field: ${
          idType === "pan" || idType === "aadhaar" ? idType : "document"
        })`,
      });
    }

    // ---- 1. Upload everything to Cloudinary first --------------------------
    // Nothing is written to MongoDB until every upload has succeeded.
    const userId = String(req.user._id);
    const toUpload = [
      { key: "primary", file: primaryIdFile, docType: idType === "pan" ? "pan" : "aadhaar" },
    ];
    // Selfie is optional - it is uploaded only if the client sends one
    if (selfieFile) {
      toUpload.push({ key: "selfie", file: selfieFile, docType: "selfie" });
    }
    // Optional extras: the other of PAN / Aadhaar, if the customer sent it
    if (panFile && panFile !== primaryIdFile) {
      toUpload.push({ key: "pan", file: panFile, docType: "pan" });
    }
    if (aadhaarFile && aadhaarFile !== primaryIdFile) {
      toUpload.push({ key: "aadhaar", file: aadhaarFile, docType: "aadhaar" });
    }

    const results = await Promise.allSettled(
      toUpload.map((item) =>
        uploadKycFile(item.file.buffer, {
          userId,
          kind: item.key === "primary" ? `id-${item.docType}` : item.key,
        })
      )
    );

    results.forEach((r) => {
      if (r.status === "fulfilled") uploaded.push(r.value);
    });

    const failed = results.find((r) => r.status === "rejected");
    if (failed) {
      await Promise.all(uploaded.map(deleteKycFile));
      console.error("Cloudinary upload failed:", failed.reason);
      return res.status(502).json({
        message: "Could not upload your documents. Please try again.",
        error: failed.reason?.message,
      });
    }

    // ---- 2. Save a Document record for each uploaded file ------------------
    const docs = {};
    for (let i = 0; i < toUpload.length; i++) {
      const asset = results[i].value;
      docs[toUpload[i].key] = await Document.create({
        user: req.user._id,
        documentType: toUpload[i].docType,
        fileUrl: asset.url,
        publicId: asset.publicId,
        resourceType: asset.resourceType,
        storageProvider: "cloudinary",
        verificationStatus: "pending",
      });
    }

    const documentRecord = docs.primary;
    const documentUrl = documentRecord.fileUrl;

    // PAN / Aadhaar slots: the primary file fills its own slot
    const panDoc = docs.pan || (documentRecord.documentType === "pan" ? documentRecord : null);
    const aadhaarDoc =
      docs.aadhaar || (documentRecord.documentType === "aadhaar" ? documentRecord : null);
    const selfieDoc = docs.selfie;

    // ---- 3. Create / update the KYC record ---------------------------------
    const ocrEligible = isOcrEligible({ idType, mimetype: primaryIdFile.mimetype });

    let kycRecord = await KYC.findOne({ user: req.user._id });

    if (kycRecord) {
      kycRecord.dob = dob || kycRecord.dob;
      kycRecord.gender = gender || kycRecord.gender;
      kycRecord.address = address || kycRecord.address;
      kycRecord.idType = idType || kycRecord.idType;
      kycRecord.idNumber = idNumber || kycRecord.idNumber;
      kycRecord.documentUrl = documentUrl;
      kycRecord.document = documentRecord._id;
      if (panDoc) {
        kycRecord.panDocument = panDoc._id;
        kycRecord.panUrl = panDoc.fileUrl;
      }
      if (aadhaarDoc) {
        kycRecord.aadhaarDocument = aadhaarDoc._id;
        kycRecord.aadhaarUrl = aadhaarDoc.fileUrl;
      }
      if (selfieDoc) {
        kycRecord.selfieDocument = selfieDoc._id;
        kycRecord.selfieUrl = selfieDoc.fileUrl;
      }
      kycRecord.verificationStatus = "under_verification";
      kycRecord.rejectionReason = "";
      // A new submission starts OCR and video KYC again from scratch
      kycRecord.ocr = { status: ocrEligible ? "processing" : "skipped" };
      kycRecord.videoKycStatus = "not_scheduled";
      kycRecord.videoKycSession = undefined;
      await kycRecord.save();
    } else {
      kycRecord = await KYC.create({
        user: req.user._id,
        document: documentRecord._id,
        dob,
        gender,
        address,
        idType,
        idNumber,
        documentUrl,
        panDocument: panDoc?._id,
        panUrl: panDoc?.fileUrl,
        aadhaarDocument: aadhaarDoc?._id,
        aadhaarUrl: aadhaarDoc?.fileUrl,
        selfieDocument: selfieDoc?._id,
        selfieUrl: selfieDoc?.fileUrl,
        verificationStatus: "under_verification",
        ocr: { status: ocrEligible ? "processing" : "skipped" },
      });
    }

    await User.findByIdAndUpdate(req.user._id, {
      kycStatus: "under_verification",
      address,
    });

    // OCR check of the ID image runs in the background; the officer sees the result
    if (ocrEligible) {
      runKycOcrInBackground({
        kycId: kycRecord._id,
        buffer: primaryIdFile.buffer,
        idType,
        idNumber,
        dob,
      });
    }

    return res.status(200).json({
      message: "KYC submitted successfully and is now under verification",
      kyc: kycRecord,
    });
  } catch (error) {
    // Something failed after the uploads - don't leave orphaned files behind
    await Promise.all(uploaded.map(deleteKycFile));
    return res.status(500).json({
      message: "Failed to submit KYC",
      error: error.message,
    });
  }
};

export const getKYCStatus = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const kyc = await KYC.findOne({ user: userId })
      .select("-ocr")
      .populate("document")
      .populate("panDocument")
      .populate("aadhaarDocument")
      .populate("selfieDocument")
      .populate("videoKycSession", "status scheduledAt durationMinutes");

    let account = await Account.findOne({ user: userId });
    if (!account && req.user.kycStatus === "verified") {
      account = await createBankAccountForUser(userId);
    }

    return res.status(200).json({
      kycStatus: req.user.kycStatus,
      kycDetails: kyc || null,
      account: account || null,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to fetch KYC status",
      error: error.message,
    });
  }
};

export const getKycQueue = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const filter = {};
    if (req.query.status) {
      filter.verificationStatus = req.query.status;
    } else {
      filter.verificationStatus = { $in: ["pending", "under_verification"] };
    }

    const [records, total] = await Promise.all([
      KYC.find(filter)
        .populate("user", "name email phone kycStatus")
        .populate("document", DOCUMENT_POPULATE_FIELDS)
        .populate("panDocument", DOCUMENT_POPULATE_FIELDS)
        .populate("aadhaarDocument", DOCUMENT_POPULATE_FIELDS)
        .populate("selfieDocument", DOCUMENT_POPULATE_FIELDS)
        .populate("videoKycSession", "status scheduledAt officer checklist recording.uploadedAt")
        .populate("verifiedBy", "name")
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      KYC.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: records,
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error("getKycQueue error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch KYC queue" });
  }
};

export const getKycDetail = async (req, res) => {
  try {
    const record = await KYC.findById(req.params.id)
      .populate("user", "name email phone address kycStatus")
      .populate("document")
      .populate("panDocument")
      .populate("aadhaarDocument")
      .populate("selfieDocument")
      .populate("videoKycSession")
      .populate("verifiedBy", "name");

    if (!record) {
      return res.status(404).json({ success: false, message: "KYC record not found" });
    }

    const otherSubmissions = await KYC.find({
      user: record.user._id,
      _id: { $ne: record._id },
    })
      .populate("document", "documentType verificationStatus")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      data: { record, otherSubmissions },
    });
  } catch (err) {
    console.error("getKycDetail error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch KYC record" });
  }
};

export const startKycReview = async (req, res) => {
  try {
    const record = await KYC.findById(req.params.id);

    if (!record) {
      return res.status(404).json({ success: false, message: "KYC record not found" });
    }

    if (record.verificationStatus === "verified" || record.verificationStatus === "rejected") {
      return res.status(409).json({
        success: false,
        message: `Cannot start review — record is already "${record.verificationStatus}"`,
      });
    }

    record.verificationStatus = "under_verification";
    record.verifiedBy = req.user._id || req.user.id;
    await record.save();

    await User.findByIdAndUpdate(record.user, { kycStatus: "under_verification" });

    return res.status(200).json({ success: true, data: record });
  } catch (err) {
    console.error("startKycReview error:", err);
    return res.status(500).json({ success: false, message: "Failed to start review" });
  }
};

export const approveKyc = async (req, res) => {
  try {
    const record = await KYC.findById(req.params.id);

    if (!record) {
      return res.status(404).json({ success: false, message: "KYC record not found" });
    }

    if (record.verificationStatus === "verified") {
      return res.status(409).json({ success: false, message: "Record is already verified" });
    }

    // Final approval needs a completed video KYC (face, document, liveness,
    // consent and recording). Set REQUIRE_VIDEO_KYC=false to skip this check.
    if (process.env.REQUIRE_VIDEO_KYC !== "false") {
      const session = record.videoKycSession
        ? await VideoKycSession.findById(record.videoKycSession)
        : null;
      const evaluation = evaluateVideoKyc(session);

      if (!evaluation.passed) {
        return res.status(409).json({
          success: false,
          message: "Video KYC is not complete, so this KYC cannot be approved yet.",
          missing: evaluation.missing,
        });
      }
    }

    // Create the bank account FIRST. Only once this succeeds do we flip the
    // KYC record and the user's kycStatus to "verified" — this guarantees
    // "verified" and "has an account" can never drift apart. If account
    // creation fails, we fail the whole approval (nothing is marked
    // verified) so the worker sees a clear error and can just retry.
    let account;
    try {
      account = await createBankAccountForUser(record.user);
    } catch (error) {
      console.error(`Bank account creation failed for user ${record.user}:`, error);
      return res.status(502).json({
        success: false,
        message: `Could not approve KYC: bank account creation failed (${error.message}). Nothing was changed — please retry.`,
      });
    }

    record.verificationStatus = "verified";
    record.verifiedAt = new Date();
    record.verifiedBy = req.user._id || req.user.id;
    record.rejectionReason = undefined;
    record.resubmissionRequested = false;
    await record.save();

    await Document.updateMany(
      { _id: { $in: kycDocumentIds(record) } },
      { verificationStatus: "verified" }
    );

    await User.findByIdAndUpdate(record.user, { kycStatus: "verified" });

    await sendNotification({
      userId: record.user,
      type: "kyc",
      title: "KYC Approved",
      message: "Your KYC document has been verified and your bank account is active.",
    }).catch((err) => console.error("Notification failed:", err));

    return res.status(200).json({
      success: true,
      message: "KYC approved successfully and bank account activated.",
      data: record,
      account,
    });
  } catch (err) {
    console.error("approveKyc error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to approve KYC" });
  }
};

export const rejectKyc = async (req, res) => {
  try {
    const { reason } = req.body;
    const requestResubmission = req.body.requestResubmission !== false;

    if (!reason || !reason.trim()) {
      return res.status(422).json({
        success: false,
        message: "A rejection reason is required",
      });
    }

    const record = await KYC.findById(req.params.id);

    if (!record) {
      return res.status(404).json({ success: false, message: "KYC record not found" });
    }

    record.verificationStatus = "rejected";
    record.verifiedAt = new Date();
    record.verifiedBy = req.user._id || req.user.id;
    record.rejectionReason = reason.trim();
    record.resubmissionRequested = requestResubmission;
    await record.save();

    await Document.updateMany(
      { _id: { $in: kycDocumentIds(record) } },
      { verificationStatus: "rejected" }
    );

    await User.findByIdAndUpdate(record.user, { kycStatus: "rejected" });

    await sendNotification({
      userId: record.user,
      type: "kyc",
      title: "KYC Document Rejected",
      message: requestResubmission
        ? `Your document was rejected: ${reason.trim()}. Please re-upload a valid document.`
        : `Your document was rejected: ${reason.trim()}.`,
    }).catch((err) => console.error("Notification failed:", err));

    return res.status(200).json({ success: true, data: record });
  } catch (err) {
    console.error("rejectKyc error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to reject KYC" });
  }
};


/**
 * POST /api/kyc/:id/ocr/retry   (worker / admin)
 * Re-runs the OCR check on the customer's ID image (e.g. after a failure).
 */
export const retryKycOcr = async (req, res) => {
  try {
    const record = await KYC.findById(req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, message: "KYC record not found" });
    }

    const doc = record.document ? await Document.findById(record.document) : null;
    if (!doc?.fileUrl || !isOcrEligible({ idType: record.idType, mimetype: "image/" })) {
      return res.status(422).json({
        success: false,
        message: "OCR is only available for PAN / Aadhaar images",
      });
    }

    const fileResponse = await fetch(doc.fileUrl);
    const contentType = fileResponse.headers.get("content-type") || "";
    if (!fileResponse.ok || !contentType.startsWith("image/")) {
      return res.status(422).json({
        success: false,
        message: "The stored document is not an image that OCR can read (PDFs are skipped)",
      });
    }

    const buffer = Buffer.from(await fileResponse.arrayBuffer());

    record.ocr = { status: "processing" };
    await record.save();

    runKycOcrInBackground({
      kycId: record._id,
      buffer,
      idType: record.idType,
      idNumber: record.idNumber,
      dob: record.dob,
    });

    return res.status(202).json({ success: true, message: "OCR started. Refresh in a few seconds." });
  } catch (err) {
    console.error("retryKycOcr error:", err);
    return res.status(500).json({ success: false, message: "Failed to start OCR" });
  }
};