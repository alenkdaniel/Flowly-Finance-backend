import crypto from "crypto";
import fs from "fs/promises";
import mongoose from "mongoose";
import KYC from "../models/KYC.js";
import User from "../models/User.js";
import VideoKycSession from "../models/VideoKycSession.js";
import { sendNotification } from "./notificationController.js";
import { uploadKycVideo } from "../services/cloudinaryService.js";
import {
  syncKycVideoStatus,
  markInProgress,
  expireIfMissed,
} from "../services/videoKycService.js";
import {
  canJoinSession,
  getJoinWindow,
  getParticipantRole,
  isSessionOfficer,
  evaluateVideoKyc,
  validateScheduledAt,
  getIceServers,
  LIVENESS_CHALLENGE_TYPES,
} from "../utils/videoKycRules.js";
import { emitToRoom } from "../sockets/videoKycSocket.js";

const userId = (req) => req.user._id || req.user.id;

const formatIst = (date) =>
  new Date(date).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });

const clampDuration = (value) => {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return 30;
  return Math.min(120, Math.max(10, Math.round(minutes)));
};

/** Is this officer already booked at that time? */
const findOfficerConflict = async (officerId, start, durationMinutes, excludeId) => {
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const candidates = await VideoKycSession.find({
    officer: officerId,
    status: { $in: ["scheduled", "in_progress"] },
    scheduledAt: { $gte: new Date(start.getTime() - 3 * 60 * 60 * 1000), $lt: end },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).select("scheduledAt durationMinutes");

  return candidates.find((other) => {
    const otherEnd = new Date(
      other.scheduledAt.getTime() + (other.durationMinutes || 30) * 60 * 1000
    );
    return other.scheduledAt < end && otherEnd > start;
  });
};

/** What the customer is allowed to see about their session */
const toCustomerView = (session) => {
  const { opensAt, closesAt } = getJoinWindow(session);
  const check = canJoinSession(session);
  return {
    id: session._id,
    status: session.status,
    scheduledAt: session.scheduledAt,
    durationMinutes: session.durationMinutes,
    joinWindow: { opensAt, closesAt },
    canJoinNow: check.ok,
    joinBlockedReason: check.ok ? undefined : check.reason,
    recordingConsentGiven: session.recordingConsent?.given === true,
    officerName: session.officer?.name,
  };
};

const loadSession = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ success: false, message: "Invalid session id" });
    return null;
  }
  const session = await VideoKycSession.findById(req.params.id);
  if (!session) {
    res.status(404).json({ success: false, message: "Video KYC session not found" });
    return null;
  }
  return session;
};

/** Loads the session and makes sure the caller is its officer (or an admin) */
const loadOfficerSession = async (req, res) => {
  const session = await loadSession(req, res);
  if (!session) return null;
  if (!isSessionOfficer(session, req.user)) {
    res.status(403).json({
      success: false,
      message: "Only the officer assigned to this session can do this",
    });
    return null;
  }
  return session;
};

// ---------------------------------------------------------------------------
// Officer / admin: scheduling
// ---------------------------------------------------------------------------

/**
 * POST /api/video-kyc/schedule
 * body: { kycId, scheduledAt, durationMinutes?, notes?, officerId? }
 */
export const scheduleVideoKyc = async (req, res) => {
  try {
    const { kycId, scheduledAt, durationMinutes, notes, officerId } = req.body;

    if (!mongoose.isValidObjectId(kycId)) {
      return res.status(422).json({ success: false, message: "A valid kycId is required" });
    }

    const when = validateScheduledAt(scheduledAt);
    if (!when.ok) return res.status(422).json({ success: false, message: when.message });

    const kyc = await KYC.findById(kycId);
    if (!kyc) return res.status(404).json({ success: false, message: "KYC record not found" });

    if (kyc.verificationStatus !== "under_verification") {
      return res.status(409).json({
        success: false,
        message: `Video KYC can only be scheduled while the KYC is under verification (current status: ${kyc.verificationStatus})`,
      });
    }

    const active = await VideoKycSession.findOne({
      kyc: kyc._id,
      status: { $in: ["scheduled", "in_progress"] },
    });
    if (active) {
      return res.status(409).json({
        success: false,
        message: "A video KYC is already scheduled for this application. Reschedule or cancel it instead.",
        sessionId: active._id,
      });
    }

    // Officer: the person scheduling, unless an admin picks someone else
    let officer = userId(req);
    if (officerId && req.user.role === "admin") {
      const chosen = await User.findById(officerId).select("role");
      if (!chosen || !["worker", "admin"].includes(chosen.role)) {
        return res.status(422).json({ success: false, message: "officerId must be a worker or admin" });
      }
      officer = chosen._id;
    }

    const duration = clampDuration(durationMinutes);

    const conflict = await findOfficerConflict(officer, when.date, duration);
    if (conflict) {
      return res.status(409).json({
        success: false,
        message: `The officer already has a video KYC at ${formatIst(conflict.scheduledAt)}. Please pick another time.`,
      });
    }

    const session = await VideoKycSession.create({
      kyc: kyc._id,
      customer: kyc.user,
      officer,
      scheduledAt: when.date,
      durationMinutes: duration,
      notes: notes ? String(notes).slice(0, 500) : "",
      roomId: crypto.randomUUID(),
    });

    await syncKycVideoStatus(session);

    await sendNotification({
      userId: kyc.user,
      type: "kyc",
      title: "Video KYC Scheduled",
      message: `Your video KYC call is scheduled for ${formatIst(session.scheduledAt)} (IST). Keep your original PAN and Aadhaar ready and join from the app at that time.`,
    }).catch((err) => console.error("Notification failed:", err));

    return res.status(201).json({ success: true, data: session });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "A video KYC is already scheduled for this application",
      });
    }
    console.error("scheduleVideoKyc error:", err);
    return res.status(500).json({ success: false, message: "Failed to schedule video KYC" });
  }
};

/** PUT /api/video-kyc/sessions/:id/reschedule   body: { scheduledAt, durationMinutes? } */
export const rescheduleVideoKyc = async (req, res) => {
  try {
    const session = await loadOfficerSession(req, res);
    if (!session) return;

    if (session.status !== "scheduled") {
      return res.status(409).json({
        success: false,
        message: `Only a scheduled session can be rescheduled (current status: ${session.status})`,
      });
    }

    const when = validateScheduledAt(req.body.scheduledAt);
    if (!when.ok) return res.status(422).json({ success: false, message: when.message });

    const duration = req.body.durationMinutes
      ? clampDuration(req.body.durationMinutes)
      : session.durationMinutes;

    const conflict = await findOfficerConflict(session.officer, when.date, duration, session._id);
    if (conflict) {
      return res.status(409).json({
        success: false,
        message: `The officer already has a video KYC at ${formatIst(conflict.scheduledAt)}. Please pick another time.`,
      });
    }

    session.scheduledAt = when.date;
    session.durationMinutes = duration;
    session.rescheduledCount += 1;
    await session.save();

    await sendNotification({
      userId: session.customer,
      type: "kyc",
      title: "Video KYC Rescheduled",
      message: `Your video KYC call has been moved to ${formatIst(session.scheduledAt)} (IST).`,
    }).catch((err) => console.error("Notification failed:", err));

    emitToRoom(session._id, "session-rescheduled", { scheduledAt: session.scheduledAt });

    return res.status(200).json({ success: true, data: session });
  } catch (err) {
    console.error("rescheduleVideoKyc error:", err);
    return res.status(500).json({ success: false, message: "Failed to reschedule video KYC" });
  }
};

/** PUT /api/video-kyc/sessions/:id/cancel   body: { reason? } */
export const cancelVideoKyc = async (req, res) => {
  try {
    const session = await loadOfficerSession(req, res);
    if (!session) return;

    if (!["scheduled", "in_progress"].includes(session.status)) {
      return res.status(409).json({
        success: false,
        message: `This session is already ${session.status}`,
      });
    }

    session.status = "cancelled";
    session.cancelReason = req.body.reason ? String(req.body.reason).slice(0, 300) : "";
    session.endedAt = new Date();
    await session.save();
    await syncKycVideoStatus(session);

    await sendNotification({
      userId: session.customer,
      type: "kyc",
      title: "Video KYC Cancelled",
      message: "Your video KYC call was cancelled. You will be contacted to schedule a new time.",
    }).catch((err) => console.error("Notification failed:", err));

    emitToRoom(session._id, "call-ended", { reason: "cancelled" });

    return res.status(200).json({ success: true, data: session });
  } catch (err) {
    console.error("cancelVideoKyc error:", err);
    return res.status(500).json({ success: false, message: "Failed to cancel video KYC" });
  }
};

// ---------------------------------------------------------------------------
// Reading sessions
// ---------------------------------------------------------------------------

/** GET /api/video-kyc/sessions?status=&from=&to=&page=&limit=   (worker/admin) */
export const listSessions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

    const filter = {};
    // A worker sees their own sessions; an admin sees everyone's
    if (req.user.role === "admin") {
      if (req.query.officerId && mongoose.isValidObjectId(req.query.officerId)) {
        filter.officer = req.query.officerId;
      }
    } else {
      filter.officer = userId(req);
    }

    if (req.query.status) filter.status = req.query.status;

    if (req.query.from || req.query.to) {
      filter.scheduledAt = {};
      if (req.query.from) filter.scheduledAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.scheduledAt.$lte = new Date(req.query.to);
    }

    const [sessions, total] = await Promise.all([
      VideoKycSession.find(filter)
        .populate("customer", "name phone email")
        .populate("officer", "name")
        .populate("kyc", "idType verificationStatus ocr.status")
        .sort({ scheduledAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      VideoKycSession.countDocuments(filter),
    ]);

    return res.status(200).json({ success: true, data: sessions, total, page, limit });
  } catch (err) {
    console.error("listSessions error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch sessions" });
  }
};

/** GET /api/video-kyc/my-session   (customer) - the customer's current / latest session */
export const getMySession = async (req, res) => {
  try {
    let session = await VideoKycSession.findOne({ customer: userId(req) })
      .sort({ createdAt: -1 })
      .populate("officer", "name");

    if (!session) {
      return res.status(200).json({ success: true, data: null, message: "No video KYC scheduled yet" });
    }

    session = await expireIfMissed(session);

    return res.status(200).json({ success: true, data: toCustomerView(session) });
  } catch (err) {
    console.error("getMySession error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch your video KYC" });
  }
};

/** GET /api/video-kyc/sessions/:id */
export const getSession = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid session id" });
    }

    let session = await VideoKycSession.findById(req.params.id)
      .populate("customer", "name phone email")
      .populate("officer", "name")
      .populate("kyc", "idType idNumber verificationStatus ocr documentUrl aadhaarUrl panUrl selfieUrl");

    if (!session) {
      return res.status(404).json({ success: false, message: "Video KYC session not found" });
    }

    const role = getParticipantRole(session, req.user);
    const isStaff = ["worker", "admin"].includes(req.user.role);

    if (role === "customer") {
      session = await expireIfMissed(session);
      return res.status(200).json({ success: true, data: toCustomerView(session) });
    }

    if (!isStaff) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }

    const evaluation = evaluateVideoKyc(session);
    return res.status(200).json({
      success: true,
      data: session,
      readyForDecision: evaluation.passed,
      missing: evaluation.missing,
    });
  } catch (err) {
    console.error("getSession error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch session" });
  }
};

// ---------------------------------------------------------------------------
// Joining the call
// ---------------------------------------------------------------------------

/**
 * POST /api/video-kyc/sessions/:id/join   (customer or officer)
 * Returns the ICE servers the browser/app needs for WebRTC.
 * Afterwards the client connects to Socket.IO and emits "join-room".
 */
export const joinSession = async (req, res) => {
  try {
    let session = await loadSession(req, res);
    if (!session) return;

    const role = getParticipantRole(session, req.user);
    if (!role) {
      return res.status(403).json({ success: false, message: "You are not part of this video KYC session" });
    }

    session = await expireIfMissed(session);

    const check = canJoinSession(session);
    if (!check.ok) {
      return res.status(409).json({
        success: false,
        code: check.code,
        message: check.reason,
        opensAt: check.opensAt,
        closesAt: check.closesAt,
      });
    }

    if (role === "officer") await markInProgress(session);

    return res.status(200).json({
      success: true,
      role,
      iceServers: getIceServers(),
      livenessChallengeTypes: role === "officer" ? LIVENESS_CHALLENGE_TYPES : undefined,
      session: {
        id: session._id,
        status: session.status,
        scheduledAt: session.scheduledAt,
        recordingConsentGiven: session.recordingConsent?.given === true,
      },
    });
  } catch (err) {
    console.error("joinSession error:", err);
    return res.status(500).json({ success: false, message: "Failed to join the session" });
  }
};

/** POST /api/video-kyc/sessions/:id/consent   (customer)   body: { given?: boolean } */
export const giveRecordingConsent = async (req, res) => {
  try {
    const session = await loadSession(req, res);
    if (!session) return;

    if (getParticipantRole(session, req.user) !== "customer") {
      return res.status(403).json({ success: false, message: "Only the customer can give consent" });
    }

    if (!["scheduled", "in_progress"].includes(session.status)) {
      return res.status(409).json({ success: false, message: `Session is ${session.status}` });
    }

    const given = req.body.given !== false;
    session.recordingConsent = { given, at: new Date(), ip: req.ip };
    await session.save();

    emitToRoom(session._id, "consent-updated", { given });

    return res.status(200).json({ success: true, recordingConsentGiven: given });
  } catch (err) {
    console.error("giveRecordingConsent error:", err);
    return res.status(500).json({ success: false, message: "Failed to save consent" });
  }
};

// ---------------------------------------------------------------------------
// During / after the call (officer)
// ---------------------------------------------------------------------------

/**
 * PUT /api/video-kyc/sessions/:id/checklist
 * body: { faceVerified?, documentVerified?, livenessPassed?, remarks? }
 */
export const updateChecklist = async (req, res) => {
  try {
    const session = await loadOfficerSession(req, res);
    if (!session) return;

    if (!["in_progress", "completed"].includes(session.status)) {
      return res.status(409).json({
        success: false,
        message: "The checklist can only be filled once the call has started",
      });
    }

    for (const key of ["faceVerified", "documentVerified", "livenessPassed"]) {
      if (req.body[key] !== undefined) {
        if (typeof req.body[key] !== "boolean") {
          return res.status(422).json({ success: false, message: `${key} must be true or false` });
        }
        session.checklist[key] = req.body[key];
      }
    }
    if (req.body.remarks !== undefined) {
      session.checklist.remarks = String(req.body.remarks).slice(0, 500);
    }

    await session.save();

    return res.status(200).json({ success: true, data: session.checklist });
  } catch (err) {
    console.error("updateChecklist error:", err);
    return res.status(500).json({ success: false, message: "Failed to update checklist" });
  }
};

/**
 * POST /api/video-kyc/sessions/:id/recording   (multipart, field: recording)
 * Uploaded by the officer's browser/app after the call; stored privately in Cloudinary.
 */
export const uploadRecording = async (req, res) => {
  const tempPath = req.file?.path;

  try {
    const session = await loadOfficerSession(req, res);
    if (!session) return;

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Please attach the recording (field: recording)" });
    }

    if (!session.recordingConsent?.given) {
      return res.status(403).json({
        success: false,
        message: "The customer has not given consent to record this call, so the recording cannot be stored",
      });
    }

    if (!["in_progress", "completed"].includes(session.status)) {
      return res.status(409).json({ success: false, message: "The call has not started" });
    }

    let asset;
    try {
      asset = await uploadKycVideo(tempPath, {
        userId: String(session.customer),
        sessionId: String(session._id),
      });
    } catch (err) {
      console.error("Recording upload failed:", err);
      return res.status(502).json({
        success: false,
        message: "Could not upload the recording. Please try again.",
        error: err.message,
      });
    }

    session.recording = {
      url: asset.url,
      publicId: asset.publicId,
      resourceType: asset.resourceType,
      durationSeconds: asset.durationSeconds,
      bytes: asset.bytes,
      uploadedAt: new Date(),
    };
    await session.save();

    return res.status(200).json({ success: true, data: session.recording });
  } catch (err) {
    console.error("uploadRecording error:", err);
    return res.status(500).json({ success: false, message: "Failed to save the recording" });
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => {});
  }
};

/** PUT /api/video-kyc/sessions/:id/end   (officer) */
export const endSession = async (req, res) => {
  try {
    const session = await loadOfficerSession(req, res);
    if (!session) return;

    if (session.status !== "in_progress") {
      return res.status(409).json({
        success: false,
        message: `Only a call in progress can be ended (current status: ${session.status})`,
      });
    }

    session.status = "completed";
    session.endedAt = new Date();
    await session.save();
    await syncKycVideoStatus(session);

    emitToRoom(session._id, "call-ended", { reason: "completed" });

    await sendNotification({
      userId: session.customer,
      type: "kyc",
      title: "Video KYC Completed",
      message: "Your video KYC call is complete. Our officer will review it and update your KYC status shortly.",
    }).catch((err) => console.error("Notification failed:", err));

    const evaluation = evaluateVideoKyc(session);

    return res.status(200).json({
      success: true,
      data: session,
      readyForDecision: evaluation.passed,
      missing: evaluation.missing,
    });
  } catch (err) {
    console.error("endSession error:", err);
    return res.status(500).json({ success: false, message: "Failed to end the session" });
  }
};