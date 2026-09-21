import KYC from "../models/KYC.js";
import { canJoinSession } from "../utils/videoKycRules.js";

/** Keep the KYC record's video status in step with its session */
export const syncKycVideoStatus = (session) =>
  KYC.findByIdAndUpdate(session.kyc, {
    videoKycStatus: session.status,
    videoKycSession: session._id,
  });

/** The call becomes "in progress" when the officer joins */
export const markInProgress = async (session) => {
  if (session.status !== "scheduled") return session;
  session.status = "in_progress";
  session.startedAt = new Date();
  await session.save();
  await syncKycVideoStatus(session);
  return session;
};

/** If a scheduled slot has passed without a call, mark it as missed */
export const expireIfMissed = async (session) => {
  if (session && session.status === "scheduled") {
    const check = canJoinSession(session);
    if (!check.ok && check.code === "expired") {
      session.status = "missed";
      await session.save();
      await syncKycVideoStatus(session);
    }
  }
  return session;
};